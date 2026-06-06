import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createProject } from "../projects";
import { bootstrap, readVerify } from "../store/store";
import { createTask, getTask, updateTask } from "../tasks";
import { applyPlan } from "./planner";
import { buildVerifierPrompt, normalizeReport, runVerifier } from "./verifier";

let db: Db;
let home: string;
let repo: string;
let worktrees: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-ver-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  repo = mkdtempSync(join(tmpdir(), "cadence-ver-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# r\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  worktrees = mkdtempSync(join(tmpdir(), "cadence-ver-wt-"));
  process.env.CADENCE_WORKTREES = worktrees;
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_WORKTREES;
  for (const d of [home, repo, worktrees]) rmSync(d, { recursive: true, force: true });
});

function verifyingTask() {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Verify me" });
  updateTask(db, task.id, { project: project.slug, status: "verifying" });
  applyPlan(task.id, { steps: [{ title: "did the thing" }] });
  return task;
}

const resultWith = (json: unknown): Promise<AgentResult> =>
  Promise.resolve({ text: JSON.stringify(json), json, costUsd: 0, sessionId: "s", isError: false, raw: {} });

test("buildVerifierPrompt instructs report-only + names the reviewer subagents", () => {
  const p = buildVerifierPrompt({ title: "T", body: "" }, "SPEC", {
    steps: [{ title: "x" }],
    approved: true,
    notes: null,
  });
  expect(p).toContain("DO NOT FIX");
  expect(p).toContain("smoke-tester");
});

test("normalizeReport drops empty entries and omits undefined nested keys", () => {
  const r = normalizeReport({
    passed: true,
    criteria: [{ criterion: "works", met: true, evidence: "tests pass" }, { criterion: "" }],
    checks: [{ name: "tests", passed: true }],
    issues: [{ detail: "nit", severity: "low" }, { detail: "" }],
  });
  expect(r.passed).toBe(true);
  expect(r.criteria).toEqual([{ criterion: "works", met: true, evidence: "tests pass" }]);
  expect(r.checks).toEqual([{ name: "tests", passed: true }]); // no undefined output key
  expect(r.issues).toEqual([{ severity: "low", detail: "nit" }]);
});

test("runVerifier pass → review; writes verify.md", async () => {
  const task = verifyingTask();
  const outcome = await runVerifier(db, task.id, () =>
    resultWith({ passed: true, checks: [{ name: "tests", passed: true }], criteria: [], issues: [] }),
  );
  expect(outcome).toMatchObject({ ran: true, passed: true, status: "review" });
  expect(getTask(db, task.id)?.status).toBe("review");
  expect(readVerify(task.id)?.passed).toBe(true);
});

test("runVerifier fail → back to implementing; records issues", async () => {
  const task = verifyingTask();
  const outcome = await runVerifier(db, task.id, () =>
    resultWith({ passed: false, issues: [{ severity: "high", detail: "tests fail", file: "x.ts" }] }),
  );
  expect(outcome).toMatchObject({ ran: true, passed: false, status: "implementing" });
  expect(getTask(db, task.id)?.status).toBe("implementing");
  expect(readVerify(task.id)?.issues[0]?.detail).toBe("tests fail");
});
