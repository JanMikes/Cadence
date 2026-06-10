import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { createProject, updateProject } from "./projects";
import { paths } from "./store/paths";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";
import {
  beginInPlaceExecution,
  branchName,
  commitInPlaceChanges,
  executionMode,
  finalizeInPlaceExecution,
  isGitRepo,
  provisionWorktree,
  readExecutionState,
  removeWorktree,
  resolveExecutionCwd,
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

// ------------------------------------------------ opt-in worktrees + in-place mode

function projectTask(opts: { worktrees?: boolean } = {}) {
  const project = createProject(db, {
    name: "Repo",
    rootPath: repo,
    worktreesEnabled: opts.worktrees ?? false,
  });
  const task = createTask(db, { title: "Change something" });
  updateTask(db, task.id, { project: project.slug });
  return { project, task };
}

function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
}

test("executionMode: worktrees are opt-in — default is in_place_branch", () => {
  const { project, task } = projectTask();
  expect(executionMode(db, task.id)).toBe("in_place_branch");

  const target = resolveExecutionCwd(db, task.id);
  expect(target).toMatchObject({ cwd: repo, worktreePath: null, inPlace: true, mode: "in_place_branch" });
  expect(target.branch).toBe(branchName(task));
  expect(currentBranch()).toBe("main"); // resolving NEVER mutates the repo

  // opting in flips execution to the isolated worktree
  updateProject(db, project.slug, { worktreesEnabled: true });
  expect(executionMode(db, task.id)).toBe("worktree");
  const wt = resolveExecutionCwd(db, task.id);
  expect(wt.inPlace).toBe(false);
  expect(wt.worktreePath?.startsWith(worktrees)).toBe(true);

  // apply_in_place delivery overrides regardless of the flag
  updateTask(db, task.id, { deliveryMode: "apply_in_place" });
  expect(executionMode(db, task.id)).toBe("apply_in_place");
  expect(resolveExecutionCwd(db, task.id)).toMatchObject({ cwd: repo, branch: null, inPlace: true });
});

test("in-place lifecycle: begin → agent edits → commit (snapshot-safe) → finalize restores base", () => {
  const { task } = projectTask();
  const branch = branchName(task);

  // a pre-existing untracked file (the user's .env) must survive uncommitted
  writeFileSync(join(repo, ".env"), "SECRET=1\n");

  beginInPlaceExecution(db, task.id);
  expect(currentBranch()).toBe(branch);
  const state = readExecutionState(task.id);
  expect(state?.baseBranch).toBe("main");
  expect(state?.untrackedBefore).toContain(".env");

  // the "agent" modifies a tracked file and creates a new one
  writeFileSync(join(repo, "README.md"), "# repo\nchanged\n");
  writeFileSync(join(repo, "feature.txt"), "new\n");

  expect(commitInPlaceChanges(repo, task.id, "cadence: Change something").committed).toBe(true);
  const committedFiles = git(["show", "--name-only", "--pretty=format:", "HEAD"], repo);
  expect(committedFiles).toContain("README.md");
  expect(committedFiles).toContain("feature.txt");
  expect(committedFiles).not.toContain(".env"); // the user's untracked file stayed out

  const fin = finalizeInPlaceExecution(db, task.id);
  expect(fin.restored).toBe(true);
  expect(currentBranch()).toBe("main");
  expect(existsSync(join(repo, ".env"))).toBe(true); // untracked carries across checkouts
  expect(existsSync(join(repo, "feature.txt"))).toBe(false); // committed on the branch only
  expect(existsSync(paths.taskExecution(task.id))).toBe(false); // state cleared

  // re-entry after request-changes reuses the same branch without complaint
  beginInPlaceExecution(db, task.id);
  expect(currentBranch()).toBe(branch);
  expect(finalizeInPlaceExecution(db, task.id).restored).toBe(true);
});

test("beginInPlaceExecution refuses a dirty tracked tree (user WIP is never tangled in)", () => {
  const { task } = projectTask();
  writeFileSync(join(repo, "README.md"), "# wip\n");
  expect(() => beginInPlaceExecution(db, task.id)).toThrow(/uncommitted change/);
  expect(currentBranch()).toBe("main");
});

test("finalizeInPlaceExecution refuses while tracked changes remain (nothing lost)", () => {
  const { task } = projectTask();
  beginInPlaceExecution(db, task.id);
  writeFileSync(join(repo, "README.md"), "# half-done\n");
  const fin = finalizeInPlaceExecution(db, task.id);
  expect(fin.restored).toBe(false);
  expect(fin.reason).toMatch(/uncommitted/);
  expect(currentBranch()).toBe(branchName(task)); // left in place for inspection
});

test("contamination guard: a new in-place run refuses to start from another task's branch", () => {
  const { task } = projectTask();
  beginInPlaceExecution(db, task.id); // repo now on task A's branch (crash leaves it there)

  const other = createTask(db, { title: "Another task" });
  updateTask(db, other.id, { project: "repo" });
  expect(() => beginInPlaceExecution(db, other.id)).toThrow(/another task's branch/);
  expect(currentBranch()).toBe(branchName(task)); // untouched — no branch was created off A
});

test("apply_in_place begin records the attribution fingerprint (HEAD sha + dirty snapshot)", () => {
  const { task } = projectTask();
  writeFileSync(join(repo, "README.md"), "# pre-existing user dirt\n");
  updateTask(db, task.id, { deliveryMode: "apply_in_place" });

  beginInPlaceExecution(db, task.id);

  expect(currentBranch()).toBe("main"); // never switches branches
  const state = readExecutionState(task.id);
  expect(state?.headShaBefore).toBeTruthy();
  expect(state?.dirtyBefore?.length).toBe(1); // the user's dirt is snapshotted, not credited
});
