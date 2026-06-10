import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createProject } from "../projects";
import { paths } from "../store/paths";
import { bootstrap, readDelivery } from "../store/store";
import { createTask, getTask, resolveDeliveryMode, updateTask } from "../tasks";
import { buildDeliveryPrompt, runDelivery } from "./delivery";

let db: Db;
let home: string;
let repo: string;
let worktrees: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-del-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  repo = mkdtempSync(join(tmpdir(), "cadence-del-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# r\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  worktrees = mkdtempSync(join(tmpdir(), "cadence-del-wt-"));
  process.env.CADENCE_WORKTREES = worktrees;
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_WORKTREES;
  for (const d of [home, repo, worktrees]) rmSync(d, { recursive: true, force: true });
});

const summaryResult = (summary: string): Promise<AgentResult> =>
  Promise.resolve({
    text: "x",
    json: { summary },
    costUsd: 0,
    sessionId: "s",
    isError: false,
    raw: {},
  });

test("resolveDeliveryMode resolves task ?? project ?? global", () => {
  const project = createProject(db, { name: "P", rootPath: repo, defaultDeliveryMode: "auto_pr" });
  const task = createTask(db, { title: "T" });
  updateTask(db, task.id, { project: project.slug });
  expect(resolveDeliveryMode(db, task.id)).toBe("auto_pr"); // project default
  updateTask(db, task.id, { deliveryMode: "apply_in_place" });
  expect(resolveDeliveryMode(db, task.id)).toBe("apply_in_place"); // task override wins
});

test("buildDeliveryPrompt references the verify checks", () => {
  const p = buildDeliveryPrompt({ title: "T", body: "" }, "SPEC", {
    passed: true,
    checks: [{ name: "tests", passed: true }],
    criteria: [],
    issues: [],
  });
  expect(p).toContain("VERIFY CHECKS");
  expect(p).toContain("tests");
});

test("branch_summary delivery writes a summary + branch, no PR (no push)", async () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Ship it" });
  updateTask(db, task.id, { project: project.slug, status: "review" });

  const outcome = await runDelivery(db, task.id, () => summaryResult("Did the thing."));
  expect(outcome).toMatchObject({ ran: true, mode: "branch_summary", prUrl: null });
  expect(outcome.branch).toContain("cadence/");

  const delivery = readDelivery(task.id);
  expect(delivery?.summary).toBe("Did the thing.");
  expect(delivery?.mode).toBe("branch_summary");
  expect(delivery?.branch).toBe(outcome.branch ?? null);

  // delivery also records the task's git context (branch · base · merged?)
  expect(getTask(db, task.id)?.gitContext).toMatchObject({
    kind: "branch",
    branch: outcome.branch,
    baseBranch: "main",
    merged: "unmerged",
  });
});

test("outputs-only delivery: no branch ceremony, outputs recorded, prompt names the files", async () => {
  const project = createProject(db, { name: "Repo3", rootPath: repo });
  const task = createTask(db, { title: "Monthly report" });
  updateTask(db, task.id, { project: project.slug, status: "review" });
  // The run's deliverable: a file in outputs/, the repo (correctly) untouched.
  mkdirSync(paths.taskOutputsDir(task.id), { recursive: true });
  writeFileSync(join(paths.taskOutputsDir(task.id), "report.pdf"), "pdf bytes");

  let prompt = "";
  const outcome = await runDelivery(db, task.id, (opts) => {
    prompt = opts.prompt;
    return summaryResult("Report generated — see report.pdf.");
  });

  // No empty branch, no PR — the files ARE the delivery.
  expect(outcome).toMatchObject({ ran: true, branch: null, prUrl: null });
  expect(prompt).toContain("OUTPUT FILES");
  expect(prompt).toContain("report.pdf");

  const delivery = readDelivery(task.id);
  expect(delivery?.outputs).toEqual(["report.pdf"]);
  expect(delivery?.branch).toBeNull();
  // nothing left to merge — same "merged from birth" treatment as direct work
  expect(getTask(db, task.id)?.gitContext).toMatchObject({ kind: "direct", merged: "merged" });
  // and the repo never left its base branch
  const head = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, stdout: "pipe" })
    .stdout.toString()
    .trim();
  expect(head).toBe("main");
});

test("apply_in_place delivery has no branch/PR", async () => {
  const project = createProject(db, { name: "Repo2", rootPath: repo });
  const task = createTask(db, { title: "In place" });
  updateTask(db, task.id, { project: project.slug, deliveryMode: "apply_in_place", status: "review" });

  const outcome = await runDelivery(db, task.id, () => summaryResult("Edited in place."));
  expect(outcome).toMatchObject({ ran: true, mode: "apply_in_place", branch: null, prUrl: null });
  expect(readDelivery(task.id)?.summary).toBe("Edited in place.");

  // direct-to-base work is merged from birth — no background check needed
  expect(getTask(db, task.id)?.gitContext).toMatchObject({ kind: "direct", merged: "merged" });
});
