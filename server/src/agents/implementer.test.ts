import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createProject } from "../projects";
import { bootstrap } from "../store/store";
import { createTask, getTask, updateTask } from "../tasks";
import { applyPlan, approvePlan } from "./planner";
import { buildImplementerPrompt, runImplementer } from "./implementer";
import type { AgentRunOptions } from "./runner";

let db: Db;
let home: string;
let repo: string;
let worktrees: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-impl-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  repo = mkdtempSync(join(tmpdir(), "cadence-impl-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  worktrees = mkdtempSync(join(tmpdir(), "cadence-impl-wt-"));
  process.env.CADENCE_WORKTREES = worktrees;
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_WORKTREES;
  for (const d of [home, repo, worktrees]) rmSync(d, { recursive: true, force: true });
});

const ok = (): Promise<AgentResult> =>
  Promise.resolve({ text: "done", json: null, costUsd: 0.5, sessionId: "s", isError: false, raw: {} });

function readyTask(opts: { worktrees?: boolean } = {}) {
  const project = createProject(db, {
    name: "Repo",
    rootPath: repo,
    // Worktree isolation is opt-in per project (default off → in-place execution).
    worktreesEnabled: opts.worktrees ?? true,
  });
  const task = createTask(db, { title: "Add a feature" });
  updateTask(db, task.id, { project: project.slug, status: "implementing" });
  return task;
}

test("buildImplementerPrompt embeds the approved steps + isolation instruction", () => {
  const p = buildImplementerPrompt(
    { title: "T", body: "" },
    "SPEC",
    { steps: [{ title: "Edit api.ts" }], approved: true, notes: null },
  );
  expect(p).toContain("isolated git worktree");
  expect(p).toContain("Edit api.ts");
});

test("runImplementer bails when the plan isn't approved", async () => {
  const task = readyTask();
  applyPlan(task.id, { steps: [{ title: "Step" }] }); // unapproved
  expect(await runImplementer(db, task.id, ok)).toMatchObject({ ran: false, reason: "plan not approved" });
});

test("runImplementer runs in the worktree with full sandboxed access, → verifying", async () => {
  const task = readyTask();
  applyPlan(task.id, { steps: [{ title: "Do the thing" }] });
  approvePlan(task.id);

  const calls: AgentRunOptions[] = [];
  const capture = (opts: AgentRunOptions): Promise<AgentResult> => {
    calls.push(opts);
    return ok();
  };
  const outcome = await runImplementer(db, task.id, capture);

  expect(outcome.ran).toBe(true);
  expect(outcome.status).toBe("verifying");
  expect(getTask(db, task.id)?.status).toBe("verifying");
  const seen = calls[0];
  expect(seen).toBeDefined();
  // ran in the provisioned worktree, not the main repo, with full tool access (bypassPermissions)
  // so it can edit + commit + build without stalling on a gated command — the sandbox is the boundary
  expect(seen?.cwd.startsWith(worktrees)).toBe(true);
  expect(seen?.cwd).toBe(outcome.worktreePath);
  expect(seen?.permissionMode).toBe("bypassPermissions");
  expect(seen?.role).toBe("implementer");
});

test("runImplementer bails (no throw) when the task has no project to isolate", async () => {
  const task = createTask(db, { title: "Orphan" });
  updateTask(db, task.id, { status: "implementing" });
  applyPlan(task.id, { steps: [{ title: "x" }] });
  approvePlan(task.id);
  const outcome = await runImplementer(db, task.id, ok);
  expect(outcome.ran).toBe(false);
  expect(outcome.reason).toMatch(/no project/);
});

test("worktrees disabled (default): runs in-place on the task branch with the resolved mode", async () => {
  const task = readyTask({ worktrees: false });
  applyPlan(task.id, { steps: [{ title: "Do the thing" }] });
  approvePlan(task.id);

  const calls: AgentRunOptions[] = [];
  const capture = (opts: AgentRunOptions): Promise<AgentResult> => {
    calls.push(opts);
    return ok();
  };
  const outcome = await runImplementer(db, task.id, capture);

  expect(outcome.ran).toBe(true);
  expect(outcome.worktreePath).toBeUndefined();
  expect(outcome.branch).toContain("cadence/");
  const seen = calls[0];
  // ran IN the project working dir, on the task branch, with the safer resolved
  // mode (auto → acceptEdits) — never bypassPermissions outside a worktree
  expect(seen?.cwd).toBe(repo);
  expect(seen?.permissionMode).toBe("acceptEdits");
  expect(seen?.prompt).toContain("DIRECTLY in the project's working copy");
  const head = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, stdout: "pipe" })
    .stdout.toString()
    .trim();
  expect(head).toBe(outcome.branch ?? "");
});

test("worktrees disabled: bails (no checkout) when the working tree has uncommitted changes", async () => {
  const task = readyTask({ worktrees: false });
  applyPlan(task.id, { steps: [{ title: "x" }] });
  approvePlan(task.id);
  writeFileSync(join(repo, "README.md"), "# dirty\n"); // tracked modification

  const outcome = await runImplementer(db, task.id, ok);
  expect(outcome.ran).toBe(false);
  expect(outcome.reason).toMatch(/uncommitted change/);
  const head = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, stdout: "pipe" })
    .stdout.toString()
    .trim();
  expect(head).toBe("main"); // untouched — the user's WIP stays exactly as it was
});

test("Dangerous mode is refused without worktree isolation (apply_in_place)", async () => {
  const project = createProject(db, { name: "Scratch", rootPath: repo });
  const task = createTask(db, { title: "Risky in place" });
  updateTask(db, task.id, {
    project: project.slug,
    status: "implementing",
    permissionMode: "dangerous",
    deliveryMode: "apply_in_place",
  });
  applyPlan(task.id, { steps: [{ title: "x" }] });
  approvePlan(task.id);
  const outcome = await runImplementer(db, task.id, ok);
  expect(outcome.ran).toBe(false);
  expect(outcome.reason).toMatch(/Dangerous mode requires/);
});
