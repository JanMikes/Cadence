import type { TaskDiff } from "@cadence/shared";
import { existsSync } from "node:fs";
import type { Db } from "./db/client";
import { getProjectById } from "./projects";
import { getTask, resolveDeliveryMode } from "./tasks";
import { branchName, isGitRepo, worktreePathFor } from "./worktree";

/**
 * The Review surface (spec §7.7/§10): show the task's changes (git diff), let me
 * merge (→ done) or request changes (→ implementing). Diff source depends on the
 * delivery mode — the per-task worktree branch, or the in-place working tree.
 */
function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString(), stderr: r.stdout.toString() + r.stderr.toString() };
}

function repoRoot(db: Db, taskId: string): string | null {
  const task = getTask(db, taskId);
  const project = task?.projectId ? getProjectById(db, task.projectId) : null;
  const rootPath = project?.rootPath;
  return rootPath && isGitRepo(rootPath) ? rootPath : null;
}

/** The task's unified diff: branch-vs-base for worktree modes, working tree for in-place. */
export function taskDiff(db: Db, taskId: string): TaskDiff {
  const task = getTask(db, taskId);
  if (!task) return { mode: "", branch: null, diff: "" };
  const mode = resolveDeliveryMode(db, taskId);
  const rootPath = repoRoot(db, taskId);
  if (!rootPath) return { mode, branch: null, diff: "" };

  if (mode === "apply_in_place") {
    return { mode, branch: null, diff: git(["diff"], rootPath).stdout };
  }
  const branch = branchName(task);
  const wt = worktreePathFor(rootPath, task);
  if (!existsSync(wt)) return { mode, branch, diff: "" };
  const base = git(["rev-parse", "--abbrev-ref", "HEAD"], rootPath).stdout.trim() || "HEAD";
  // include both committed branch changes and any uncommitted working changes
  const committed = git(["diff", `${base}...HEAD`], wt).stdout;
  const working = git(["diff"], wt).stdout;
  return { mode, branch, diff: committed + working };
}

export interface MergeResult {
  ok: boolean;
  message: string;
}

/** Merge the task's branch into the repo's base (the human "I merge" step). */
export function mergeTask(db: Db, taskId: string): MergeResult {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, message: "task not found" };
  const mode = resolveDeliveryMode(db, taskId);
  if (mode === "apply_in_place") return { ok: true, message: "changes already applied in place" };
  const rootPath = repoRoot(db, taskId);
  if (!rootPath) return { ok: false, message: "no git repo to merge into" };
  const branch = branchName(task);
  const r = git(["merge", "--no-ff", "-m", `Merge ${branch} (Cadence)`, branch], rootPath);
  return { ok: r.ok, message: r.ok ? `merged ${branch}` : r.stderr.trim() };
}
