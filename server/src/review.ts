import type { TaskDiff } from "@cadence/shared";
import { existsSync } from "node:fs";
import type { Db } from "./db/client";
import { getProjectById } from "./projects";
import { getTask, resolveDeliveryMode } from "./tasks";
import {
  branchName,
  clearExecutionState,
  isGitRepo,
  readExecutionState,
  worktreePathFor,
} from "./worktree";

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

/** The task's unified diff: branch-vs-base for branch modes (worktree or in-place
 *  branch in the main repo), working tree for apply_in_place. */
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
  if (existsSync(wt)) {
    const base = git(["rev-parse", "--abbrev-ref", "HEAD"], rootPath).stdout.trim() || "HEAD";
    // include both committed branch changes and any uncommitted working changes
    const committed = git(["diff", `${base}...HEAD`], wt).stdout;
    const working = git(["diff"], wt).stdout;
    return { mode, branch, diff: committed + working };
  }
  // In-place execution (worktrees disabled): the task branch lives in the main repo.
  const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], rootPath).ok;
  if (!branchExists) return { mode, branch, diff: "" };
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], rootPath).stdout.trim();
  const onBranch = current === branch;
  // Mid-execution the repo IS on the task branch — diff against the recorded base;
  // after delivery restored the base, diff base...branch directly.
  const base = onBranch ? (readExecutionState(taskId)?.baseBranch ?? "") : current || "HEAD";
  const committed = base ? git(["diff", `${base}...${branch}`], rootPath).stdout : "";
  const working = onBranch ? git(["diff"], rootPath).stdout : "";
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
  // In-place execution that couldn't restore its base: merging now would merge the
  // branch into itself. Surface it instead of silently "succeeding".
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], rootPath).stdout.trim();
  if (current === branch) {
    return { ok: false, message: `repo is still on ${branch} — switch back to the base branch first` };
  }
  const r = git(["merge", "--no-ff", "-m", `Merge ${branch} (Cadence)`, branch], rootPath);
  if (!r.ok) return { ok: false, message: r.stderr.trim() };
  // In-place branches (no worktree holding them) are deleted after merge so the
  // user's repo stays tidy; worktree branches stay (the worktree pins them).
  if (!existsSync(worktreePathFor(rootPath, task))) {
    git(["branch", "-d", branch], rootPath); // best-effort
    clearExecutionState(taskId);
  }
  return { ok: true, message: `merged ${branch}` };
}
