import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { createProject } from "./projects";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";
import { mergeTask, taskDiff } from "./review";
import { provisionWorktree } from "./worktree";

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

test("apply_in_place diff reads the working tree; merge is a no-op", () => {
  const project = createProject(db, { name: "InPlace", rootPath: repo });
  const task = createTask(db, { title: "Edit in place" });
  updateTask(db, task.id, { project: project.slug, deliveryMode: "apply_in_place", status: "review" });
  writeFileSync(join(repo, "README.md"), "# r\nedited in place\n");

  const d = taskDiff(db, task.id);
  expect(d.mode).toBe("apply_in_place");
  expect(d.branch).toBeNull();
  expect(d.diff).toContain("edited in place");
  expect(mergeTask(db, task.id)).toMatchObject({ ok: true });
});
