import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Db } from "./db/client";
import { getProjectById } from "./projects";
import { paths } from "./store/paths";
import { getTask, resolveDeliveryMode, resolveTaskCwd } from "./tasks";

/**
 * Per-task git worktree provisioning (spec §5/§9). Worktree isolation is OPT-IN
 * per project (`worktreesEnabled`, default off) — not every repo runs from a
 * fresh second checkout (.env files, docker ports, install steps). When enabled,
 * the Implementer runs in an isolated worktree + branch so a runaway never
 * touches the user's main tree. When disabled, execution runs IN the project
 * working dir on the same deterministic task branch (serialized by the
 * per-project write lock) and the base branch is restored after delivery.
 * Branch + path are *deterministic* functions of the task, so provisioning is
 * idempotent and the verifier/delivery reuse the same tree.
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

/**
 * How execution (Implementer/Verifier/Delivery) touches the repo:
 *  - "worktree"        — isolated per-task worktree + branch (project opted in).
 *  - "in_place_branch" — the project working dir itself, on the task branch
 *                        (worktrees disabled — the default); serialized per project.
 *  - "apply_in_place"  — the working dir, current branch, no git ceremony
 *                        (explicit apply_in_place delivery mode).
 */
export type ExecutionMode = "worktree" | "in_place_branch" | "apply_in_place";

export function executionMode(db: Db, taskId: string): ExecutionMode {
  if (resolveDeliveryMode(db, taskId) === "apply_in_place") return "apply_in_place";
  const task = getTask(db, taskId);
  const project = task?.projectId ? getProjectById(db, task.projectId) : null;
  return project?.worktreesEnabled ? "worktree" : "in_place_branch";
}

/** Where execution runs. `inPlace` = the project working dir is being mutated
 *  directly (no isolation) — that's what the per-project write lock protects. */
export interface ExecutionTarget {
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  inPlace: boolean;
  mode: ExecutionMode;
}

export function resolveExecutionCwd(db: Db, taskId: string): ExecutionTarget {
  const mode = executionMode(db, taskId);
  if (mode === "apply_in_place") {
    return { cwd: resolveTaskCwd(db, taskId), branch: null, worktreePath: null, inPlace: true, mode };
  }
  if (mode === "in_place_branch") {
    const task = getTask(db, taskId);
    if (!task) throw new Error(`execution: task ${taskId} not found`);
    if (!task.projectId) throw new Error("execution: task has no project — assign one first");
    const rootPath = getProjectById(db, task.projectId)?.rootPath;
    if (!rootPath) throw new Error("execution: project has no rootPath");
    if (!isGitRepo(rootPath)) throw new Error(`execution: ${rootPath} is not a git repo`);
    return { cwd: rootPath, branch: branchName(task), worktreePath: null, inPlace: true, mode };
  }
  const wt = provisionWorktree(db, taskId);
  return { cwd: wt.path, branch: wt.branch, worktreePath: wt.path, inPlace: false, mode };
}

/** What the API chain must lock before executing this task: the project, when the
 *  run would mutate its working dir (null = worktree-isolated or nothing lockable). */
export function executionLockTarget(
  db: Db,
  taskId: string,
): { projectId: string; rootPath: string } | null {
  if (executionMode(db, taskId) === "worktree") return null;
  const task = getTask(db, taskId);
  const project = task?.projectId ? getProjectById(db, task.projectId) : null;
  if (!project?.rootPath) return null;
  return { projectId: project.id, rootPath: project.rootPath };
}

// ------------------------------------------------ in-place execution lifecycle

/** Crash-safe runtime state for an in-place execution (execution.json): which
 *  branch to restore after delivery, and which untracked paths pre-existed (so a
 *  delivery commit never swallows the user's .env / scratch files). */
export interface InPlaceExecutionState {
  baseBranch: string | null;
  untrackedBefore: string[];
  startedAt: number;
}

export function readExecutionState(taskId: string): InPlaceExecutionState | null {
  const file = paths.taskExecution(taskId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as InPlaceExecutionState;
  } catch {
    return null;
  }
}

function writeExecutionState(taskId: string, state: InPlaceExecutionState): void {
  mkdirSync(paths.taskDir(taskId), { recursive: true });
  writeFileSync(paths.taskExecution(taskId), `${JSON.stringify(state, null, 2)}\n`);
}

export function clearExecutionState(taskId: string): void {
  rmSync(paths.taskExecution(taskId), { force: true });
}

/** Current branch name; falls back to the commit sha when detached (checkout of a
 *  sha restores the exact pre-execution state). */
function currentBranch(rootPath: string): string {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], rootPath);
  if (r.ok && r.stdout && r.stdout !== "HEAD") return r.stdout;
  return git(["rev-parse", "HEAD"], rootPath).stdout;
}

/** `git status --porcelain` lines; untracked excluded when `tracked` is set. */
function statusLines(rootPath: string, opts: { tracked?: boolean } = {}): string[] {
  const args = ["status", "--porcelain"];
  if (opts.tracked) args.push("--untracked-files=no");
  const r = git(args, rootPath);
  return r.ok && r.stdout ? r.stdout.split("\n").filter(Boolean) : [];
}

/** Untracked paths from porcelain `?? ` lines (git-quoted names unquoted). */
function untrackedPaths(rootPath: string): string[] {
  return statusLines(rootPath)
    .filter((l) => l.startsWith("?? "))
    .map((l) => {
      const p = l.slice(3).trim();
      return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
    });
}

/**
 * Start an in-place execution: refuse a dirty tree (the user's uncommitted work
 * must never get tangled into a task branch), snapshot pre-existing untracked
 * paths, then check out the task branch (created off the current HEAD, reused on
 * re-entry after a failed verify). Caller holds the project write lock. Throws
 * with a clear message — the Implementer surfaces it as a graceful bail.
 */
export function beginInPlaceExecution(db: Db, taskId: string): ExecutionTarget {
  const target = resolveExecutionCwd(db, taskId);
  if (target.mode !== "in_place_branch" || !target.branch) return target;
  const root = target.cwd;
  const branch = target.branch;

  if (currentBranch(root) === branch) {
    // Re-entry (verify failed → re-approve, or a resumed run): keep the original
    // snapshot — it still describes the pre-execution tree.
    if (!readExecutionState(taskId)) {
      writeExecutionState(taskId, {
        baseBranch: null, // unknown — a crash lost it; finalize will ask for a manual switch
        untrackedBefore: untrackedPaths(root),
        startedAt: Date.now(),
      });
    }
    return target;
  }

  const dirty = statusLines(root, { tracked: true });
  if (dirty.length > 0) {
    throw new Error(
      `in-place execution: ${root} has ${dirty.length} uncommitted change(s) — ` +
        "commit or stash them, or enable worktrees for this project",
    );
  }

  const base = currentBranch(root);
  const untrackedBefore = untrackedPaths(root);
  const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).ok;
  const r = git(branchExists ? ["checkout", branch] : ["checkout", "-b", branch], root);
  if (!r.ok) throw new Error(`in-place execution: git checkout failed: ${r.stderr}`);
  writeExecutionState(taskId, { baseBranch: base, untrackedBefore, startedAt: Date.now() });
  return target;
}

/**
 * Commit an in-place execution's changes onto the task branch: tracked
 * modifications plus only NEW untracked files (the pre-execution snapshot —
 * the user's .env and scratch files — stays out). No-op when the Implementer
 * already committed everything. Deterministic subprocess, never permission-gated.
 */
export function commitInPlaceChanges(
  rootPath: string,
  taskId: string,
  message: string,
): { committed: boolean } {
  const before = new Set(readExecutionState(taskId)?.untrackedBefore ?? []);
  git(["add", "-u"], rootPath);
  for (const p of untrackedPaths(rootPath)) {
    if (!before.has(p)) git(["add", "--", p], rootPath);
  }
  const staged = !git(["diff", "--cached", "--quiet"], rootPath).ok; // exit 1 → something staged
  if (!staged) return { committed: false };
  return { committed: git(["commit", "-m", message], rootPath).ok };
}

export interface FinalizeResult {
  restored: boolean;
  reason?: string;
}

/**
 * End an in-place execution: switch the working dir back to the base branch so
 * the repo (and every read stage) sees its normal state again, and clear the
 * execution state. Refuses (without losing anything) when tracked changes are
 * still uncommitted or the base branch is unknown — the caller surfaces it.
 */
export function finalizeInPlaceExecution(db: Db, taskId: string): FinalizeResult {
  const task = getTask(db, taskId);
  if (!task) return { restored: false, reason: "task not found" };
  const rootPath = task.projectId ? getProjectById(db, task.projectId)?.rootPath : null;
  if (!rootPath || !isGitRepo(rootPath)) return { restored: false, reason: "no git project" };

  if (currentBranch(rootPath) !== branchName(task)) {
    clearExecutionState(taskId); // already off the task branch (user switched) — done
    return { restored: true };
  }
  const state = readExecutionState(taskId);
  if (!state?.baseBranch) {
    return { restored: false, reason: "base branch unknown — switch back manually" };
  }
  if (statusLines(rootPath, { tracked: true }).length > 0) {
    return { restored: false, reason: "uncommitted changes remain on the task branch" };
  }
  const r = git(["checkout", state.baseBranch], rootPath);
  if (!r.ok) return { restored: false, reason: `git checkout ${state.baseBranch} failed: ${r.stderr}` };
  clearExecutionState(taskId);
  return { restored: true };
}
