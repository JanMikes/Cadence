import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 *  delivery commit never swallows the user's .env / scratch files). Also the
 *  ATTRIBUTION FINGERPRINT: where HEAD and the tracked tree stood before the run,
 *  so recovery/merge can tell the task's work apart from the user's (or another
 *  actor's) changes in a shared working dir. */
export interface InPlaceExecutionState {
  baseBranch: string | null;
  untrackedBefore: string[];
  startedAt: number;
  /** HEAD sha when the run began — work exists iff the repo moved past it or new dirt appeared. */
  headShaBefore?: string | null;
  /** Tracked-dirty porcelain lines when the run began (apply_in_place runs in a possibly-dirty tree). */
  dirtyBefore?: string[];
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
export function currentBranch(rootPath: string): string {
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

  if (target.mode === "apply_in_place") {
    // No checkout and no dirty-tree refusal (this mode's point is "work in my live
    // tree"), but DO record the attribution fingerprint — without it, a dead run
    // is indistinguishable from delivered work and the user's own dirt gets
    // credited to the task (the route-state incident). Re-entry keeps the
    // original snapshot: it still anchors what the task changed.
    if (isGitRepo(target.cwd) && !readExecutionState(taskId)) {
      writeExecutionState(taskId, {
        baseBranch: null, // informational only — apply_in_place never switches branches
        untrackedBefore: untrackedPaths(target.cwd),
        startedAt: Date.now(),
        headShaBefore: git(["rev-parse", "HEAD"], target.cwd).stdout || null,
        dirtyBefore: statusLines(target.cwd, { tracked: true }),
      });
    }
    return target;
  }
  if (target.mode !== "in_place_branch" || !target.branch) return target;
  const root = target.cwd;
  const branch = target.branch;

  const current = currentBranch(root);
  if (current === branch) {
    // Re-entry (verify failed → re-approve, or a resumed run): keep the original
    // snapshot — it still describes the pre-execution tree.
    if (!readExecutionState(taskId)) {
      writeExecutionState(taskId, {
        baseBranch: null, // unknown — a crash lost it; finalize will ask for a manual switch
        untrackedBefore: untrackedPaths(root),
        startedAt: Date.now(),
        headShaBefore: null,
        dirtyBefore: [],
      });
    }
    return target;
  }

  // Cross-task contamination guard: starting from another task's cadence/* branch
  // would silently base this task's work (and its later merge) on unreviewed
  // commits from that task. Restore the base first — boot does it automatically
  // when safe (restoreAbandonedExecutions).
  if (current.startsWith("cadence/")) {
    throw new Error(
      `in-place execution: ${root} is still on another task's branch (${current}) — ` +
        "that execution didn't finish; restore the base branch first (Cadence does this " +
        "automatically at startup when the tree is safe to move)",
    );
  }

  // A live index.lock means some other git process (a user command, an editor's
  // git integration, another tool) is mutating the repo RIGHT NOW — checking out
  // over it corrupts both. Refuse with an actionable message; a crashed git
  // leaves a stale lock the user removes once.
  if (existsSync(join(root, ".git", "index.lock"))) {
    throw new Error(
      `in-place execution: ${root}/.git/index.lock exists — another git process is ` +
        "working in this repo (or crashed and left a stale lock; delete the file if so)",
    );
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
  writeExecutionState(taskId, {
    baseBranch: base,
    untrackedBefore,
    startedAt: Date.now(),
    headShaBefore: git(["rev-parse", "HEAD"], root).stdout || null,
    dirtyBefore: [],
  });
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
  /** When set, refuse unless the repo is still ON this branch — the user (or an
   *  external actor) may have switched branches mid-run, and committing there
   *  would write the task's work into someone else's history. */
  expectedBranch?: string,
): { committed: boolean; reason?: string } {
  if (expectedBranch) {
    const current = currentBranch(rootPath);
    if (current !== expectedBranch) {
      return {
        committed: false,
        reason: `repo is on ${current}, not ${expectedBranch} — refusing to commit the task's work onto another branch`,
      };
    }
  }
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

// ------------------------------------------------------- work-product evidence

/**
 * What we can honestly attribute to a task's execution. `hasWork` is the single
 * verdict every consumer keys on: recovery promotes to Review only with it, merge
 * refuses to mark Done without it, and the implementer doesn't advance an
 * empty-handed run. `attributable: false` means the question is unanswerable
 * (no git repo) — callers must not treat that as either delivered or empty.
 */
export interface WorkEvidence {
  mode: ExecutionMode;
  attributable: boolean;
  hasWork: boolean;
  /** Commits on the task branch ahead of its base (branch modes; 0 for apply_in_place). */
  commitsAhead: number;
  /** Uncommitted changes attributable to the task's run. */
  dirty: boolean;
  /** Human-readable explanation — goes on the task's context channel verbatim. */
  detail: string;
}

function noEvidence(mode: ExecutionMode, attributable: boolean, detail: string): WorkEvidence {
  return { mode, attributable, hasWork: false, commitsAhead: 0, dirty: false, detail };
}

/** Commits on `branch` not on `base`; 0 when either ref is unresolvable. */
function commitsAhead(root: string, base: string, branch: string): number {
  const r = git(["rev-list", "--count", `${base}..${branch}`], root);
  return r.ok ? Number.parseInt(r.stdout, 10) || 0 : 0;
}

/**
 * Inspect the repo for work attributable to this task. Read-only — never
 * provisions a worktree or touches a branch.
 *
 * - worktree / in_place_branch: decisive — the task branch either has commits
 *   ahead of base (or task-owned uncommitted changes) or it doesn't. Dirt in the
 *   shared tree only counts while the repo is ON the task branch (the begin guard
 *   refused pre-existing dirt, so on-branch dirt is the run's).
 * - apply_in_place: anchored to the execution fingerprint (HEAD sha + dirty
 *   snapshot recorded at begin). No fingerprint → no run ever began → no work.
 *   Shared-tree caveat: changes made by the user DURING the run are
 *   indistinguishable from the agent's — "changed since the run began" is the
 *   honest best available.
 */
export function taskWorkEvidence(db: Db, taskId: string): WorkEvidence {
  const task = getTask(db, taskId);
  if (!task) return noEvidence("apply_in_place", false, "task not found");
  const mode = executionMode(db, taskId);

  if (mode === "apply_in_place") {
    const cwd = resolveTaskCwd(db, taskId);
    if (!isGitRepo(cwd)) {
      return noEvidence(mode, false, "no git repo — work product can't be verified");
    }
    const state = readExecutionState(taskId);
    if (!state?.headShaBefore) {
      return noEvidence(mode, true, "no recorded execution for this task ever began — nothing attributable to it");
    }
    const headNow = git(["rev-parse", "HEAD"], cwd).stdout;
    const moved = headNow !== state.headShaBefore;
    const dirtyBefore = new Set(state.dirtyBefore ?? []);
    const newDirt = statusLines(cwd, { tracked: true }).filter((l) => !dirtyBefore.has(l));
    const untrackedBefore = new Set(state.untrackedBefore);
    const newUntracked = untrackedPaths(cwd).filter((p) => !untrackedBefore.has(p));
    const dirty = newDirt.length > 0 || newUntracked.length > 0;
    if (!moved && !dirty) {
      return noEvidence(mode, true, "the tree is unchanged since the run began — no work was delivered");
    }
    return {
      mode,
      attributable: true,
      hasWork: true,
      commitsAhead: 0,
      dirty,
      detail: moved
        ? "the run committed work since it began"
        : `the run changed ${newDirt.length + newUntracked.length} file(s) since it began`,
    };
  }

  const rootPath = task.projectId ? getProjectById(db, task.projectId)?.rootPath : null;
  if (!rootPath || !isGitRepo(rootPath)) {
    return noEvidence(mode, false, "no git repo — work product can't be verified");
  }
  const branch = branchName(task);
  const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], rootPath).ok;
  if (!branchExists) {
    return noEvidence(mode, true, `the task branch ${branch} doesn't exist — the implementer never delivered any work`);
  }
  const current = currentBranch(rootPath);
  const onBranch = current === branch;
  const base = (onBranch ? readExecutionState(taskId)?.baseBranch : current) || "HEAD";
  const ahead = commitsAhead(rootPath, base, branch);

  let dirty = false;
  const wt = worktreePathFor(rootPath, task);
  if (existsSync(wt)) {
    // An existing worktree is authoritative regardless of the project flag (it may
    // have been toggled after provisioning — same rule as taskDiff). Isolated tree —
    // any change in it is the task's.
    dirty = statusLines(wt).length > 0;
  } else if (onBranch) {
    // On the task branch, tracked dirt is the run's (begin refused pre-existing dirt),
    // and so are untracked files NOT in the pre-execution snapshot — exactly the set
    // a delivery commit would pick up.
    const untrackedBefore = new Set(readExecutionState(taskId)?.untrackedBefore ?? []);
    dirty =
      statusLines(rootPath, { tracked: true }).length > 0 ||
      untrackedPaths(rootPath).some((p) => !untrackedBefore.has(p));
  }

  if (ahead === 0 && !dirty) {
    return noEvidence(mode, true, `the task branch ${branch} has no commits and no changes — no work was delivered`);
  }
  return {
    mode,
    attributable: true,
    hasWork: true,
    commitsAhead: ahead,
    dirty,
    detail:
      ahead > 0
        ? `${branch} has ${ahead} commit(s) ahead of ${base}${dirty ? " plus uncommitted changes" : ""}`
        : `${branch} has uncommitted changes (the run didn't finish committing)`,
  };
}

/** Task ids with a persisted in-place execution state (execution.json) — the
 *  crash-safe record of every run that may have left a repo on a task branch. */
export function listExecutionStateTaskIds(): string[] {
  try {
    return readdirSync(paths.tasksDir()).filter((id) => existsSync(paths.taskExecution(id)));
  } catch {
    return [];
  }
}
