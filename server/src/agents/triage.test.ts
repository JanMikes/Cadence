import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "../db/client";
import { createProject } from "../projects";
import { bootstrap, readContext, readQa } from "../store/store";
import { createTask, getTask, getTaskDetail } from "../tasks";
import type { AgentRunner } from "./triage";
import {
  applyTriageProjectAnswer,
  buildTriagePrompt,
  runTriage,
  TRIAGE_PROJECT_QUESTION_ID,
} from "./triage";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-triage-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** A mock agent runner that returns a fixed triage JSON as its result. */
function mockRunner(triage: object): AgentRunner {
  return async (): Promise<AgentResult> => ({
    text: JSON.stringify(triage),
    json: triage,
    costUsd: 0.0005,
    sessionId: "mock",
    isError: false,
    raw: { result: JSON.stringify(triage) },
  });
}

test("buildTriagePrompt includes the task + known projects", () => {
  const p = buildTriagePrompt({ title: "Fix login", body: "users locked out" }, [
    { slug: "acme", name: "Acme" },
  ]);
  expect(p).toContain("Fix login");
  expect(p).toContain("users locked out");
  expect(p).toContain("acme (Acme)");
  expect(p).not.toContain('"title"'); // a user-written title is never re-asked
});

test("buildTriagePrompt asks for a title when capture was description-only", () => {
  const p = buildTriagePrompt({ title: "derived…", body: "long description" }, [], {
    titleNeeded: true,
  });
  expect(p).toContain("captured without a title");
  expect(p).toContain('"title":"string"');
});

test("a sufficient triage routes the task → Triaged with project/priority/deadline/labels", async () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/acme" });
  const task = createTask(db, { title: "Fix the acme login bug" });

  const outcome = await runTriage(
    db,
    task.id,
    mockRunner({
      sufficiency: "ok",
      restatement: "Fix the broken Acme login flow",
      projectSlug: "acme",
      priority: "P1",
      deadline: "2026-07-15",
      labels: ["bug", "auth"],
    }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "triaged" });
  const t = getTask(db, task.id);
  expect(t?.status).toBe("triaged");
  expect(t?.priority).toBe("P1");
  expect(t?.projectId).toBeTruthy(); // slug resolved to FK id
  expect(t?.deadline).toBe(Date.parse("2026-07-15"));
  expect(readContext(task.id)).toContain("Triage restatement: Fix the broken Acme login flow");
});

test("an insufficient triage → Needs-Feedback with what's needed", async () => {
  const task = createTask(db, { title: "do the thing" });
  const outcome = await runTriage(
    db,
    task.id,
    mockRunner({ sufficiency: "insufficient", needFromUser: "Which project, and what 'thing'?" }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "needs_feedback" });
  expect(getTask(db, task.id)?.status).toBe("needs_feedback");
  expect(readContext(task.id)).toContain("Which project");
});

test("triage names a description-only task; a user title is never overwritten", async () => {
  // Description-only capture → placeholder title, which the agent replaces.
  const unnamed = createTask(db, { body: "the login page 500s when the token expired" });
  expect(getTaskDetail(db, unnamed.id)?.titleGenerated).toBe(true);
  await runTriage(
    db,
    unnamed.id,
    mockRunner({ sufficiency: "ok", title: "Fix expired-token 500 on login", priority: "P1" }),
  );
  const renamed = getTaskDetail(db, unnamed.id);
  expect(renamed?.title).toBe("Fix expired-token 500 on login");
  expect(renamed?.titleGenerated).toBe(false); // properly named now

  // Explicit user title → the agent's title is ignored.
  const named = createTask(db, { title: "My exact wording", body: "details" });
  await runTriage(
    db,
    named.id,
    mockRunner({ sufficiency: "ok", title: "Agent rewording", priority: "P2" }),
  );
  expect(getTask(db, named.id)?.title).toBe("My exact wording");
});

test("triage still names the task when it bails as insufficient", async () => {
  const task = createTask(db, { body: "something about the deploy?" });
  await runTriage(
    db,
    task.id,
    mockRunner({
      sufficiency: "insufficient",
      needFromUser: "Which deploy, and what should change?",
      title: "Clarify deploy issue",
    }),
  );
  const t = getTaskDetail(db, task.id);
  expect(t?.status).toBe("needs_feedback");
  expect(t?.title).toBe("Clarify deploy issue"); // board shows a real name while it waits
});

test("capture-pinned fields survive triage (the user's explicit picks win)", async () => {
  const acme = createProject(db, { name: "Acme", rootPath: "/tmp/acme" });
  createProject(db, { name: "Tools", rootPath: "/tmp/tools" });
  const pinnedDeadline = Date.parse("2026-06-20");
  const task = createTask(db, {
    title: "Ship the export",
    project: "acme",
    priority: "P0",
    deadline: pinnedDeadline,
    fixedFields: ["project", "priority", "deadline"],
  });

  const outcome = await runTriage(
    db,
    task.id,
    mockRunner({
      sufficiency: "ok",
      restatement: "Ship it",
      projectSlug: "tools", // all of these conflict with the pins — must be ignored
      priority: "P3",
      deadline: "2030-01-01",
      labels: ["export"],
    }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "triaged" });
  const t = getTaskDetail(db, task.id);
  expect(t?.projectId).toBe(acme.id); // still acme, not tools
  expect(t?.priority).toBe("P0");
  expect(t?.deadline).toBe(pinnedDeadline);
  expect(t?.labels).toEqual(["export"]); // unpinned fields still applied
});

test("an explicitly-unassigned project (pinned None) is never auto-routed", async () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/acme" });
  const task = createTask(db, { title: "Plan the offsite", fixedFields: ["project"] });

  await runTriage(
    db,
    task.id,
    mockRunner({ sufficiency: "ok", restatement: "Plan it", projectSlug: "acme", priority: "P2" }),
  );

  const t = getTask(db, task.id);
  expect(t?.status).toBe("triaged");
  expect(t?.projectId).toBeNull(); // the user said "no project" — triage must not override
  expect(t?.priority).toBe("P2");
});

test("buildTriagePrompt surfaces pinned fields so the model doesn't re-decide them", () => {
  const p = buildTriagePrompt({ title: "t", body: "" }, [{ slug: "acme", name: "Acme" }], {
    fixed: [
      { field: "project", value: "acme" },
      { field: "deadline", value: "(none)" },
    ],
  });
  expect(p).toContain("do NOT output or change these fields: project=acme, deadline=(none)");
  expect(p).toContain("projectCandidates"); // the abstain-don't-guess instruction is in the default
});

test("auto project + unconfident triage → a 'which project?' card instead of a guess", async () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/acme" });
  createProject(db, { name: "Tools", rootPath: "/tmp/tools" });
  const task = createTask(db, { title: "Tweak the build cache" });

  const outcome = await runTriage(
    db,
    task.id,
    mockRunner({
      sufficiency: "ok",
      restatement: "Speed up builds",
      projectSlug: null,
      projectCandidates: ["tools", "bogus-slug"], // unknown slugs are filtered out
      priority: "P2",
      labels: ["build"],
    }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "needs_feedback", askedProject: true });
  const t = getTaskDetail(db, task.id);
  expect(t?.status).toBe("needs_feedback");
  expect(t?.projectId).toBeNull(); // no guess
  expect(t?.priority).toBe("P2"); // the rest of triage still applied

  const qa = readQa(task.id);
  expect(qa.questions).toHaveLength(1);
  const q = qa.questions[0];
  expect(q?.id).toBe(TRIAGE_PROJECT_QUESTION_ID);
  expect(q?.type).toBe("single_choice");
  expect(q?.options).toEqual(["tools", "acme", "None"]); // candidates first, then the rest, then None
});

test("abstention with no valid candidates degrades to triaged-without-project", async () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/acme" });
  const task = createTask(db, { title: "Buy a new monitor" });

  const outcome = await runTriage(
    db,
    task.id,
    mockRunner({ sufficiency: "ok", restatement: "Buy it", projectSlug: null, priority: "P3" }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "triaged" });
  expect(getTask(db, task.id)?.projectId).toBeNull();
  expect(readQa(task.id).questions).toHaveLength(0);
});

test("answering the project card assigns + pins the project and resumes (slug and None)", async () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/acme" });
  createProject(db, { name: "Tools", rootPath: "/tmp/tools" });
  const task = createTask(db, { title: "Tweak the build cache" });
  await runTriage(
    db,
    task.id,
    mockRunner({ sufficiency: "ok", projectSlug: null, projectCandidates: ["tools"], priority: "P2" }),
  );

  // Unknown choice → rejected.
  expect(applyTriageProjectAnswer(db, task.id, "nope")).toMatchObject({ ok: false, resume: false });

  const applied = applyTriageProjectAnswer(db, task.id, "tools");
  expect(applied).toEqual({ ok: true, resume: true });
  const t = getTaskDetail(db, task.id);
  expect(t?.status).toBe("triaged");
  expect(t?.projectId).toBeTruthy();
  expect(readQa(task.id).questions).toHaveLength(0); // card consumed — never re-counted by the Questioner
  expect(readContext(task.id)).toContain("A: tools");

  // Second call: the card is gone.
  expect(applyTriageProjectAnswer(db, task.id, "tools").ok).toBe(false);

  // "None" path: assigns no project but still resumes.
  const other = createTask(db, { title: "Another ambiguous one" });
  await runTriage(
    db,
    other.id,
    mockRunner({ sufficiency: "ok", projectSlug: null, projectCandidates: ["acme"] }),
  );
  expect(applyTriageProjectAnswer(db, other.id, "None")).toEqual({ ok: true, resume: true });
  expect(getTask(db, other.id)?.status).toBe("triaged");
  expect(getTask(db, other.id)?.projectId).toBeNull();
});

test("unparseable triage output leaves the task in Inbox", async () => {
  const task = createTask(db, { title: "x" });
  const runner: AgentRunner = async () => ({
    text: "sorry, not json",
    json: null,
    costUsd: 0,
    sessionId: null,
    isError: false,
    raw: {},
  });
  expect(await runTriage(db, task.id, runner)).toEqual({ ran: false });
  expect(getTask(db, task.id)?.status).toBe("inbox");
});
