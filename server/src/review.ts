import type { TaskDiff } from "@cadence/shared";
import { existsSync } from "node:fs";
import type { Db } from "./db/client";
import { markTaskMergedByCadence } from "./git-context";
import { getProjectById } from "./projects";
import { listOutputs } from "./store/store";
import { getTask, resolveDeliveryMode } from "./tasks";
import {
  branchName,
  clearExecutionState,
  isGitRepo,
  readExecutionState,
  taskWorkEvidence,
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
    // Anchor at the run's fingerprint when one exists: "what changed since the run
    // began" (commits + working tree) instead of whatever happens to be dirty —
    // a shared tree may carry the user's unrelated WIP.
    const anchor = readExecutionState(taskId)?.headShaBefore;
    return { mode, branch: null, diff: git(anchor ? ["diff", anchor] : ["diff"], rootPath).stdout };
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

/** Merge the task's branch into the repo's base (the human "I merge" step).
 *  Done must mean delivered: a missing branch, an empty branch, or an
 *  apply_in_place task with no attributable work refuses LOUDLY instead of
 *  fabricating success (the route-state incident: a run killed mid-flight was
 *  "merged" because the user's own dirty tree was credited to the task). */
export function mergeTask(db: Db, taskId: string): MergeResult {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, message: "task not found" };
  const mode = resolveDeliveryMode(db, taskId);
  if (mode === "apply_in_place") {
    const evidence = taskWorkEvidence(db, taskId);
    if (evidence.attributable && !evidence.hasWork) {
      // Outputs-only delivery: the work product is the files in outputs/, not the
      // repo — a clean tree is the CORRECT outcome, not an empty run.
      if (listOutputs(taskId).length > 0) {
        return { ok: true, message: "no repo changes — the task's deliverables are its output files" };
      }
      return {
        ok: false,
        message: `nothing was delivered — ${evidence.detail}; send the task back to implementation instead of marking it done`,
      };
    }
    return { ok: true, message: "changes already applied in place" };
  }
  const rootPath = repoRoot(db, taskId);
  if (!rootPath) return { ok: false, message: "no git repo to merge into" };
  const branch = branchName(task);
  // In-place execution that couldn't restore its base: merging now would merge the
  // branch into itself. Surface it instead of silently "succeeding".
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], rootPath).stdout.trim();
  if (current === branch) {
    return { ok: false, message: `repo is still on ${branch} — switch back to the base branch first` };
  }
  const evidence = taskWorkEvidence(db, taskId);
  if (evidence.attributable && !evidence.hasWork) {
    // Outputs-only delivery: nothing in git BY DESIGN. Mark done without a merge,
    // and tidy the (empty) task branch the same way a merged in-place branch is.
    if (listOutputs(taskId).length > 0) {
      if (!existsSync(worktreePathFor(rootPath, task))) {
        git(["branch", "-d", branch], rootPath); // best-effort
        clearExecutionState(taskId);
      }
      return { ok: true, message: "no repo changes to merge — the task's deliverables are its output files" };
    }
    return { ok: false, message: `nothing to merge — ${evidence.detail}` };
  }
  if (evidence.attributable && evidence.commitsAhead === 0 && evidence.dirty) {
    // git would report "Already up to date" and the dirt would be lost from the
    // task's record — make the half-finished state explicit instead.
    return {
      ok: false,
      message: `the task's changes are uncommitted on ${branch} — the run didn't finish; request changes to re-run, or commit them manually`,
    };
  }
  const r = git(["merge", "--no-ff", "-m", `Merge ${branch} (Cadence)`, branch], rootPath);
  if (!r.ok) return { ok: false, message: r.stderr.trim() };
  // In-place branches (no worktree holding them) are deleted after merge so the
  // user's repo stays tidy; worktree branches stay (the worktree pins them).
  if (!existsSync(worktreePathFor(rootPath, task))) {
    git(["branch", "-d", branch], rootPath); // best-effort
    clearExecutionState(taskId);
  }
  // The git context flips to merged instantly — no background check needed for the
  // happy path (this is also why "branch exists?" is never the merged-signal: the
  // in-place branch was just deleted above).
  markTaskMergedByCadence(db, taskId);
  return { ok: true, message: `merged ${branch}` };
}
