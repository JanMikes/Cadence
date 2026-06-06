import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Db } from "./db/client";
import { getProjectById } from "./projects";
import { getTask, resolveDeliveryMode, resolveTaskCwd } from "./tasks";

/**
 * Per-task git worktree provisioning (spec §5/§9: isolation by default). The
 * Implementer runs in an isolated worktree + branch so a runaway never touches
 * the user's main tree. Branch + path are *deterministic* functions of the task,
 * so provisioning is idempotent and the verifier/delivery reuse the same tree.
 */
export interface Worktree {
  path: string;
  branch: string;
  rootPath: string;
}

function git(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout.toString().trim(),
    stderr: r.stderr.toString().trim(),
  };
}

export function isGitRepo(dir: string): boolean {
  return existsSync(dir) && git(["rev-parse", "--is-inside-work-tree"], dir).ok;
}

/** A git-safe slug from the task title (used in the branch name). */
export function slugifyTitle(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "task";
}

/** `cadence/<slug>-<id8>` — readable yet collision-free across tasks. */
export function branchName(task: { id: string; title: string }): string {
  return `cadence/${slugifyTitle(task.title)}-${task.id.slice(0, 8)}`;
}

/** Where worktrees live: $CADENCE_WORKTREES, else a sibling `.cadence-worktrees`
 *  dir next to the repo (out of the main tree, near it — spec §5). */
export function worktreeBase(rootPath: string): string {
  return process.env.CADENCE_WORKTREES ?? join(dirname(rootPath), ".cadence-worktrees");
}

export function worktreePathFor(rootPath: string, task: { id: string }): string {
  return join(worktreeBase(rootPath), `${basename(rootPath)}-${task.id.slice(0, 8)}`);
}

/**
 * Ensure a git worktree + branch exist for this task's project repo. Idempotent:
 * an existing worktree at the computed path is reused. Throws (with a clear
 * message) if the task has no project, the project has no rootPath, or rootPath
 * isn't a git repo — the caller surfaces it.
 */
export function provisionWorktree(db: Db, taskId: string): Worktree {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`worktree: task ${taskId} not found`);
  if (!task.projectId) {
    throw new Error("worktree: task has no project — assign one to isolate execution");
  }
  const project = getProjectById(db, task.projectId);
  const rootPath = project?.rootPath;
  if (!rootPath) throw new Error("worktree: project has no rootPath");
  return provisionWorktreeAt(rootPath, task);
}

/** Provision a worktree for `task` in a SPECIFIC repo (used per-member by fleets). */
export function provisionWorktreeAt(rootPath: string, task: { id: string; title: string }): Worktree {
  if (!isGitRepo(rootPath)) throw new Error(`worktree: ${rootPath} is not a git repo`);

  const branch = branchName(task);
  const path = worktreePathFor(rootPath, task);
  if (existsSync(path)) return { path, branch, rootPath }; // already provisioned

  mkdirSync(dirname(path), { recursive: true });
  // Reuse the branch if it already exists (e.g. a prior worktree was removed),
  // otherwise create it off the current HEAD.
  const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], rootPath).ok;
  const args = branchExists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path];
  const r = git(args, rootPath);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.stderr}`);
  return { path, branch, rootPath };
}

/** Remove a task's worktree (cleanup after delivery/cancel). Best-effort. */
export function removeWorktree(wt: Worktree): boolean {
  return git(["worktree", "remove", "--force", wt.path], wt.rootPath).ok;
}

/** Where execution (Implementer/Verifier/Delivery) runs, per delivery mode:
 *  apply_in_place edits the repo directly (no isolation); the others get a
 *  per-task worktree. Throws (via provisionWorktree) when a worktree is needed
 *  but the task has no git project. */
export interface ExecutionTarget {
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
}
export function resolveExecutionCwd(db: Db, taskId: string): ExecutionTarget {
  if (resolveDeliveryMode(db, taskId) === "apply_in_place") {
    return { cwd: resolveTaskCwd(db, taskId), branch: null, worktreePath: null };
  }
  const wt = provisionWorktree(db, taskId);
  return { cwd: wt.path, branch: wt.branch, worktreePath: wt.path };
}
