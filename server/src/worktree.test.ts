import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { createProject } from "./projects";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";
import {
  branchName,
  isGitRepo,
  provisionWorktree,
  removeWorktree,
  slugifyTitle,
  worktreePathFor,
} from "./worktree";

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
  home = mkdtempSync(join(tmpdir(), "cadence-wt-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  // A real git repo with one commit (worktree add needs a HEAD).
  repo = mkdtempSync(join(tmpdir(), "cadence-wt-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  worktrees = mkdtempSync(join(tmpdir(), "cadence-wt-base-"));
  process.env.CADENCE_WORKTREES = worktrees;
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_WORKTREES;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktrees, { recursive: true, force: true });
});

test("slugifyTitle + branchName produce a readable, git-safe branch", () => {
  expect(slugifyTitle("Add OAuth login!!")).toBe("add-oauth-login");
  expect(slugifyTitle("   ")).toBe("task");
  const b = branchName({ id: "abcd1234-zzzz", title: "Add OAuth login" });
  expect(b).toBe("cadence/add-oauth-login-abcd1234");
});

test("isGitRepo distinguishes a repo from a plain dir", () => {
  expect(isGitRepo(repo)).toBe(true);
  expect(isGitRepo(home)).toBe(false);
});

test("provisionWorktree creates an isolated worktree + branch, idempotently", () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Add OAuth login" });
  updateTask(db, task.id, { project: project.slug });

  const wt = provisionWorktree(db, task.id);
  expect(existsSync(wt.path)).toBe(true);
  expect(wt.path.startsWith(worktrees)).toBe(true); // outside the main tree
  expect(wt.branch).toBe(branchName({ id: task.id, title: "Add OAuth login" }));
  // git knows about the worktree + the branch
  expect(git(["worktree", "list"], repo)).toContain(wt.path);
  expect(git(["branch", "--list", wt.branch], repo)).toContain("cadence/");

  // idempotent: a second call reuses the same path/branch (no throw)
  const again = provisionWorktree(db, task.id);
  expect(again.path).toBe(wt.path);

  // cleanup removes it from git's worktree list
  expect(removeWorktree(wt)).toBe(true);
  expect(git(["worktree", "list"], repo)).not.toContain(wt.path);
});

test("provisionWorktree refuses a task with no project or a non-repo rootPath", () => {
  const orphan = createTask(db, { title: "No project" });
  expect(() => provisionWorktree(db, orphan.id)).toThrow(/no project/);

  const notRepo = mkdtempSync(join(tmpdir(), "cadence-notrepo-"));
  const project = createProject(db, { name: "Plain", rootPath: notRepo });
  const task = createTask(db, { title: "In a non-repo" });
  updateTask(db, task.id, { project: project.slug });
  expect(() => provisionWorktree(db, task.id)).toThrow(/not a git repo/);
  rmSync(notRepo, { recursive: true, force: true });
});

test("worktreePathFor honors CADENCE_WORKTREES + the repo basename", () => {
  const p = worktreePathFor(repo, { id: "deadbeef-1111" });
  expect(p.startsWith(worktrees)).toBe(true);
  expect(p).toContain("deadbeef");
});
