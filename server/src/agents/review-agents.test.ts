import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResult } from "@cadence/shared";
import { type Db, migrateDb, openDb } from "../db/client";
import type { ForgeReviewApi } from "../forge-review";
import { bootstrap, readReviewFindings, readReviewProposal, writeReviewProposal } from "../store/store";
import { createTask, getTask, updateTask } from "../tasks";
import { runReviewResponderApply, runReviewResponderPropose } from "./review-responder";
import { runReviewer } from "./reviewer";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-review-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function reviewTask(direction: "perform" | "address"): string {
  const t = createTask(db, {
    title: "Review the widget PR",
    body: "Should stabilize login.",
    taskType: "code_review",
    reviewDirection: direction,
    reviewRef: "https://github.com/acme/widget/pull/42",
  });
  return t.id;
}

function fakeApi(over: Partial<ForgeReviewApi> = {}): (forge: "github" | "gitlab") => ForgeReviewApi {
  const api: ForgeReviewApi = {
    fetchMeta: () => ({
      title: "Fix login",
      author: "octocat",
      state: "open",
      baseBranch: "main",
      headBranch: "fix/login",
      url: "https://github.com/acme/widget/pull/42",
      body: "desc",
      ciStatus: "success",
    }),
    fetchDiff: () => "diff --git a/login.ts b/login.ts\n+fixed\n",
    fetchThreads: () => [],
    publishReview: () => ({ url: null }),
    replyToThread: () => {},
    resolveThread: () => true,
    ...over,
  };
  return () => api;
}

function ok(json: unknown): AgentResult {
  return { text: JSON.stringify(json), json, costUsd: 0, sessionId: null, isError: false, raw: {} };
}

test("reviewer (§6.5.c): pre-fetched meta+diff reach the prompt; findings land as artifacts; task → review", async () => {
  const id = reviewTask("perform");
  let prompt = "";
  const outcome = await runReviewer(
    db,
    id,
    async (opts) => {
      prompt = opts.prompt;
      return ok({
        summary: "One blocker.",
        verdictSuggestion: "request_changes",
        findings: [
          { severity: "blocker", file: "login.ts", line: 12, title: "Races", body: "This races.", evidence: "e" },
          { severity: "weird", file: "", line: 0, title: "dropped — no file" }, // normalized away
        ],
      });
    },
    fakeApi(),
  );

  expect(outcome).toMatchObject({ ran: true, status: "review", findings: 1 });
  expect(prompt).toContain("Fix login"); // pre-fetched meta embedded
  expect(prompt).toContain("diff --git"); // pre-fetched diff embedded
  expect(prompt).toContain("Should stabilize login."); // task description flows in
  const findings = readReviewFindings(id);
  expect(findings?.verdictSuggestion).toBe("request_changes");
  expect(findings?.findings).toHaveLength(1);
  expect(getTask(db, id)?.status).toBe("review");
});

test("reviewer: forge fetch failure → needs_feedback with a plain-language note (never a crash)", async () => {
  const id = reviewTask("perform");
  const outcome = await runReviewer(
    db,
    id,
    async () => ok({}),
    fakeApi({
      fetchMeta: () => {
        throw new Error("gh: not logged in");
      },
    }),
  );
  expect(outcome.status).toBe("needs_feedback");
  expect(getTask(db, id)?.status).toBe("needs_feedback");
});

test("responder propose (§6.5.d): unresolved threads → proposal artifact, task → plan_review", async () => {
  const id = reviewTask("address");
  let prompt = "";
  const outcome = await runReviewResponderPropose(
    db,
    id,
    async (opts) => {
      prompt = opts.prompt;
      return ok({
        threads: [
          { threadId: "RT_1", classification: "must_fix", reply: "Fixed.", patch: "--- a\n+++ b", resolves: true },
          { threadId: "", classification: "question", reply: "dropped" }, // no id → normalized away
        ],
        overallNote: "One fix, done.",
      });
    },
    fakeApi({
      fetchThreads: () => [
        { id: "RT_1", resolved: false, resolvable: true, file: "login.ts", line: 12, comments: [{ author: "rev", body: "Race?", createdAt: null }] },
        { id: "RT_2", resolved: true, resolvable: true, file: null, line: null, comments: [] }, // filtered
      ],
    }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "plan_review", threads: 1 });
  expect(prompt).toContain("RT_1");
  expect(prompt).not.toContain("RT_2"); // resolved threads never reach the agent
  expect(readReviewProposal(id)?.threads[0]?.classification).toBe("must_fix");
  expect(getTask(db, id)?.status).toBe("plan_review");
});

test("responder propose: zero unresolved threads → happy empty proposal, task → review", async () => {
  const id = reviewTask("address");
  const outcome = await runReviewResponderPropose(db, id, async () => ok({}), fakeApi());
  expect(outcome).toMatchObject({ ran: true, status: "review", threads: 0 });
  expect(readReviewProposal(id)?.overallNote).toContain("No unresolved feedback");
});

test("responder apply: accepted fixes run the agent and stamp appliedAt; skip-only → straight to review", async () => {
  const id = reviewTask("address");
  updateTask(db, id, { status: "plan_review" });
  writeReviewProposal(id, {
    threads: [
      { threadId: "RT_1", classification: "must_fix", reply: "Fixed.", patch: "patch-1", resolves: true },
      { threadId: "RT_2", classification: "pushback", reply: "Kept as-is.", resolves: false },
    ],
    overallNote: "",
    generatedAt: Date.now(),
  });

  let prompt = "";
  const outcome = await runReviewResponderApply(db, id, "/tmp/repo", async (opts) => {
    prompt = opts.prompt;
    return ok({ done: true });
  });
  expect(outcome).toMatchObject({ ran: true, status: "review", threads: 1 });
  expect(prompt).toContain("patch-1");
  expect(prompt).not.toContain("RT_2"); // pushback threads are replies, not code changes
  expect(readReviewProposal(id)?.appliedAt).toBeGreaterThan(0);

  // all-skip proposal: nothing to apply, no agent run needed
  const id2 = reviewTask("address");
  updateTask(db, id2, { status: "plan_review" });
  writeReviewProposal(id2, {
    threads: [{ threadId: "RT_9", classification: "must_fix", reply: "r", patch: "p", resolves: true, decision: "skip" }],
    overallNote: "",
    generatedAt: Date.now(),
  });
  let ran = false;
  const o2 = await runReviewResponderApply(db, id2, "/tmp/repo", async () => {
    ran = true;
    return ok({});
  });
  expect(ran).toBe(false);
  expect(o2.status).toBe("review");
});

test("strictness setting reaches the reviewer prompt (§6.5.h)", async () => {
  const { readSettings, writeSettings } = await import("../store/store");
  writeSettings({ ...readSettings(), review: { strictness: "strict" } });
  const id = reviewTask("perform");
  let prompt = "";
  await runReviewer(
    db,
    id,
    async (opts) => {
      prompt = opts.prompt;
      return ok({ summary: "s", verdictSuggestion: "comment", findings: [] });
    },
    fakeApi(),
  );
  expect(prompt).toContain("Strictness: strict");
});
