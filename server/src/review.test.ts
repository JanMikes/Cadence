import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { createProject } from "./projects";
import { paths } from "./store/paths";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";
import { mergeTask, taskDiff } from "./review";
import { beginInPlaceExecution, provisionWorktree } from "./worktree";

let db: Db;
let home: string;
let repo: string;
let worktrees: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-rev-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  repo = mkdtempSync(join(tmpdir(), "cadence-rev-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# r\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  worktrees = mkdtempSync(join(tmpdir(), "cadence-rev-wt-"));
  process.env.CADENCE_WORKTREES = worktrees;
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_WORKTREES;
  for (const d of [home, repo, worktrees]) rmSync(d, { recursive: true, force: true });
});

function taskWithChange() {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Add a file" });
  updateTask(db, task.id, { project: project.slug, status: "review" });
  // simulate the Implementer: a commit on the task's worktree branch
  const wt = provisionWorktree(db, task.id);
  writeFileSync(join(wt.path, "feature.txt"), "hello from the feature\n");
  git(["add", "."], wt.path);
  git(["commit", "-q", "-m", "add feature"], wt.path);
  return { task, branch: wt.branch };
}

test("taskDiff surfaces the worktree branch's committed change", () => {
  const { task } = taskWithChange();
  const d = taskDiff(db, task.id);
  expect(d.mode).toBe("branch_summary");
  expect(d.branch).toContain("cadence/");
  expect(d.diff).toContain("feature.txt");
  expect(d.diff).toContain("hello from the feature");
});

test("mergeTask merges the branch into the repo's base", () => {
  const { task, branch } = taskWithChange();
  const result = mergeTask(db, task.id);
  expect(result.ok).toBe(true);
  // the change is now on main
  const log = git(["log", "--oneline"], repo);
  expect(log).toContain("add feature");
  expect(git(["branch", "--list", branch], repo)).toContain("cadence/");
});

test("apply_in_place diff reads the working tree; merge requires attributable work", () => {
  const project = createProject(db, { name: "InPlace", rootPath: repo });
  const task = createTask(db, { title: "Edit in place" });
  updateTask(db, task.id, { project: project.slug, deliveryMode: "apply_in_place", status: "review" });

  // No execution ever began → tree dirt is NOT the task's work; merging would
  // fabricate a Done (the route-state incident).
  writeFileSync(join(repo, "README.md"), "# r\nthe user's own WIP\n");
  expect(mergeTask(db, task.id)).toMatchObject({ ok: false });
  expect(mergeTask(db, task.id).message).toMatch(/nothing was delivered/);

  // A recorded run that actually changed something merges fine — and the diff is
  // anchored at the run's fingerprint.
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "user wip committed"], repo);
  beginInPlaceExecution(db, task.id);
  writeFileSync(join(repo, "README.md"), "# r\nedited in place by the run\n");

  const d = taskDiff(db, task.id);
  expect(d.mode).toBe("apply_in_place");
  expect(d.branch).toBeNull();
  expect(d.diff).toContain("edited in place by the run");
  expect(mergeTask(db, task.id)).toMatchObject({ ok: true });
});

test("mergeTask refuses a task branch that was never created (no work delivered)", () => {
  const project = createProject(db, { name: "NoBranch", rootPath: repo });
  const task = createTask(db, { title: "Never ran" });
  updateTask(db, task.id, { project: project.slug, status: "review" });

  const result = mergeTask(db, task.id);
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/never delivered/);
});

test("mergeTask refuses an empty task branch (zero commits ahead of base)", () => {
  const project = createProject(db, { name: "EmptyBranch", rootPath: repo });
  const task = createTask(db, { title: "Empty branch" });
  updateTask(db, task.id, { project: project.slug, status: "review" });
  provisionWorktree(db, task.id); // branch + worktree exist, but no commits, no edits

  const result = mergeTask(db, task.id);
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/no commits and no changes/);
});

test("mergeTask accepts an outputs-only task — no repo changes is the CORRECT outcome", () => {
  const project = createProject(db, { name: "ReportOnly", rootPath: repo });
  const task = createTask(db, { title: "Monthly report" });
  updateTask(db, task.id, { project: project.slug, status: "review" });
  // No branch, no commits — the deliverable lives in outputs/ (a report task
  // SHOULD leave git untouched).
  mkdirSync(paths.taskOutputsDir(task.id), { recursive: true });
  writeFileSync(join(paths.taskOutputsDir(task.id), "report.pdf"), "pdf bytes");

  const result = mergeTask(db, task.id);
  expect(result.ok).toBe(true);
  expect(result.message).toMatch(/output files/);
});

test("mergeTask refuses while the task's work sits uncommitted (run didn't finish)", () => {
  const project = createProject(db, { name: "HalfDone", rootPath: repo });
  const task = createTask(db, { title: "Half done" });
  updateTask(db, task.id, { project: project.slug, status: "review" });
  const wt = provisionWorktree(db, task.id);
  writeFileSync(join(wt.path, "feature.txt"), "uncommitted\n"); // work exists but no commit

  const result = mergeTask(db, task.id);
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/uncommitted/);
});
