import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import {
  checkTaskGitContext,
  detectBaseBranch,
  markTaskMergedByCadence,
  recordDeliveryGitContext,
  sweepGitContexts,
} from "./git-context";
import { createProject } from "./projects";
import { mergeTask } from "./review";
import { bootstrap, writeDelivery } from "./store/store";
import { createTask, getTask, setTaskPrUrl, updateTask } from "./tasks";
import { branchName } from "./worktree";
import type { WsHub } from "./ws";

let db: Db;
let home: string;
let repo: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-gitctx-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  repo = mkdtempSync(join(tmpdir(), "cadence-gitctx-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# r\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  for (const d of [home, repo]) rmSync(d, { recursive: true, force: true });
});

/** A delivered task: one commit on its (deterministic) task branch, repo back on main. */
function deliveredBranchTask(status = "done") {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Feature work" });
  updateTask(db, task.id, { project: project.slug, status });
  const branch = branchName(task);
  git(["checkout", "-q", "-b", branch], repo);
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "feature work"], repo);
  git(["checkout", "-q", "main"], repo);
  const ctx = recordDeliveryGitContext(db, task.id, {
    mode: "branch_summary",
    branch,
    rootPath: repo,
  });
  return { task, branch, ctx };
}

function fakeHub() {
  const sent: { name: string; payload?: unknown }[] = [];
  const hub = {
    broadcast: (msg: { type: string; name: string; payload?: unknown }) =>
      sent.push({ name: msg.name, payload: msg.payload }),
  } as unknown as WsHub;
  return { hub, sent };
}

test("detectBaseBranch finds main", () => {
  expect(detectBaseBranch(repo)).toBe("main");
});

test("delivery records branch · base · tip commit · unmerged, persisted on the task", () => {
  const { task, branch, ctx } = deliveredBranchTask();
  expect(ctx).toMatchObject({
    kind: "branch",
    branch,
    baseBranch: "main",
    merged: "unmerged",
    mergedVia: null,
  });
  expect(ctx?.deliveryCommit).toBe(git(["rev-parse", branch], repo));
  expect(getTask(db, task.id)?.gitContext).toMatchObject({ branch, merged: "unmerged" });
});

test("apply_in_place delivery records a direct, already-merged context", () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Edit in place" });
  updateTask(db, task.id, { project: project.slug, deliveryMode: "apply_in_place", status: "done" });
  const ctx = recordDeliveryGitContext(db, task.id, {
    mode: "apply_in_place",
    branch: null,
    rootPath: repo,
  });
  expect(ctx).toMatchObject({ kind: "direct", branch: null, baseBranch: "main", merged: "merged" });
});

test("no git repo → no fake context", () => {
  const project = createProject(db, { name: "NoRepo" });
  const task = createTask(db, { title: "T" });
  updateTask(db, task.id, { project: project.slug });
  const ctx = recordDeliveryGitContext(db, task.id, {
    mode: "branch_summary",
    branch: "x",
    rootPath: null,
  });
  expect(ctx).toBeNull();
  expect(getTask(db, task.id)?.gitContext).toBeNull();
});

test("check detects a merge done outside Cadence (ancestry)", () => {
  const { task, branch } = deliveredBranchTask();
  git(["merge", "--no-ff", "-q", "-m", "merge it myself", branch], repo);

  const first = checkTaskGitContext(db, task.id);
  expect(first?.changed).toBe(true);
  expect(first?.context).toMatchObject({ merged: "merged", mergedVia: "external" });
  // settled: a second check changes nothing
  expect(checkTaskGitContext(db, task.id)?.changed).toBe(false);
});

test("squash merge with the branch kept → merged via patch equivalence", () => {
  const { task, branch } = deliveredBranchTask();
  git(["merge", "--squash", "-q", branch], repo);
  git(["commit", "-q", "-m", "squashed feature"], repo);

  const r = checkTaskGitContext(db, task.id);
  expect(r?.context).toMatchObject({ merged: "merged", mergedVia: "external" });
});

test("squash merge with the branch deleted → branch_gone (honest, not guessed)", () => {
  const { task, branch } = deliveredBranchTask();
  git(["merge", "--squash", "-q", branch], repo);
  git(["commit", "-q", "-m", "squashed feature"], repo);
  git(["branch", "-D", branch], repo);

  const r = checkTaskGitContext(db, task.id);
  expect(r?.context.merged).toBe("branch_gone");
});

test("forge PR state catches merges local git can't see", () => {
  const { task } = deliveredBranchTask();
  setTaskPrUrl(db, task.id, "https://github.com/o/r/pull/5");

  const r = checkTaskGitContext(db, task.id, { prState: () => "merged" });
  expect(r?.context).toMatchObject({ merged: "merged", mergedVia: "forge" });
});

test("unmerged work stays unmerged (no false positives)", () => {
  const { task } = deliveredBranchTask();
  const r = checkTaskGitContext(db, task.id, { prState: () => "open" });
  expect(r?.context.merged).toBe("unmerged");
  expect(r?.changed).toBe(false);
});

test("Cadence's own merge flips the context instantly", () => {
  const { task } = deliveredBranchTask("review");
  expect(mergeTask(db, task.id).ok).toBe(true);
  expect(getTask(db, task.id)?.gitContext).toMatchObject({
    merged: "merged",
    mergedVia: "cadence",
    baseBranch: "main",
  });
});

test("markTaskMergedByCadence backfills a minimal context for pre-feature tasks", () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Old task" });
  updateTask(db, task.id, { project: project.slug, status: "review" });
  const ctx = markTaskMergedByCadence(db, task.id);
  expect(ctx).toMatchObject({ merged: "merged", mergedVia: "cadence", branch: branchName(task) });
});

test("check backfills context from delivery.md for tasks delivered before the feature", () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Legacy delivery" });
  updateTask(db, task.id, { project: project.slug, status: "done" });
  const branch = branchName(task);
  git(["checkout", "-q", "-b", branch], repo);
  writeFileSync(join(repo, "legacy.txt"), "legacy\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "legacy work"], repo);
  git(["checkout", "-q", "main"], repo);
  writeDelivery(task.id, { mode: "branch_summary", summary: "did it", branch, prUrl: null });

  const r = checkTaskGitContext(db, task.id);
  expect(r?.changed).toBe(true);
  expect(r?.context).toMatchObject({ kind: "branch", branch, baseBranch: "main", merged: "unmerged" });
  expect(r?.context.deliveryCommit).toBe(git(["rev-parse", branch], repo));
});

test("sweep broadcasts + notifies on an external merge, then settles", () => {
  const { task, branch } = deliveredBranchTask("review");
  git(["merge", "--no-ff", "-q", "-m", "merged in a terminal", branch], repo);

  const { hub, sent } = fakeHub();
  const first = sweepGitContexts(db, hub);
  expect(first.changed).toBe(1);
  expect(sent.some((m) => m.name === "task:updated" && m.payload === task.id)).toBe(true);
  const notify = sent.find((m) => m.name === "notify");
  expect(notify).toBeDefined();
  expect((notify?.payload as { kind: string }).kind).toBe("info");
  // a review task is nudged toward closing, never auto-flipped
  expect((notify?.payload as { message: string }).message).toContain("mark the task done");
  expect(getTask(db, task.id)?.status).toBe("review");

  // merged tasks leave the candidate set — the sweep self-drains
  const { hub: hub2, sent: sent2 } = fakeHub();
  expect(sweepGitContexts(db, hub2)).toMatchObject({ checked: 0, changed: 0 });
  expect(sent2.length).toBe(0);
});

test("sweep skips tasks with nothing delivered and direct deliveries", () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const undelivered = createTask(db, { title: "Never delivered" });
  updateTask(db, undelivered.id, { project: project.slug, status: "done" });

  const { hub, sent } = fakeHub();
  expect(sweepGitContexts(db, hub)).toMatchObject({ checked: 0, changed: 0 });
  expect(sent.length).toBe(0);
});
