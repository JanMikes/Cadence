import type { TaskGitContext } from "@cadence/shared";
import type { Db } from "./db/client";
import { recordEvent } from "./events";
import { lookupPrState, parsePrUrl, type PrState } from "./forge";
import { notifyGitMergedExternally } from "./notify";
import { getProjectById } from "./projects";
import { readDelivery } from "./store/store";
import { getTask, listTasks, setTaskGitContext } from "./tasks";
import { branchName, isGitRepo } from "./worktree";
import type { WsHub } from "./ws";

/**
 * Per-task git context (branch · base · merged?) — the honest answer to "did this
 * task's work actually land?". Three write points:
 *
 *   1. Delivery records the initial context (which branch, what it merges into, the
 *      tip commit — the anchor that survives branch deletion).
 *   2. Cadence's own Merge button flips it to merged instantly (review.ts).
 *   3. The background sweep here resolves the out-of-band world: merges done in a
 *      terminal, PR/MR merges on the forge (incl. squash/rebase, which ancestry
 *      can't see), deleted branches.
 *
 * Everything is deterministic git subprocesses (+ an optional cached gh/glab call
 * when a PR exists) — no agent, no tokens. A task whose work merged leaves the
 * candidate set permanently, so the sweep self-drains.
 */

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString().trim() };
}

/** Current branch name, or null when detached. */
function currentBranch(rootPath: string): string | null {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], rootPath);
  return r.ok && r.stdout && r.stdout !== "HEAD" ? r.stdout : null;
}

function localBranchExists(rootPath: string, branch: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], rootPath).ok;
}

/** The repo's base branch: origin's default (origin/HEAD), else main/master, else null. */
export function detectBaseBranch(rootPath: string): string | null {
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], rootPath);
  if (head.ok && head.stdout) {
    const name = head.stdout.replace(/^origin\//, "");
    if (localBranchExists(rootPath, name)) return name;
  }
  for (const name of ["main", "master"]) {
    if (localBranchExists(rootPath, name)) return name;
  }
  return null;
}

/** True when every commit on `branch` has an equivalent patch already in `base`
 *  (git cherry) — how a squash/rebase merge looks to local git. */
function cherryEquivalent(rootPath: string, base: string, branch: string): boolean {
  const r = git(["cherry", base, branch], rootPath);
  if (!r.ok || !r.stdout) return false;
  const lines = r.stdout.split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((l) => l.startsWith("-"));
}

/**
 * Record a task's initial git context at delivery time. For apply_in_place the work
 * is already on the base branch ("merged" from birth); branch modes record the task
 * branch, its tip commit, and the base it should merge into. Returns null (and
 * writes nothing) when the project has no usable git repo — no fake context.
 */
export function recordDeliveryGitContext(
  db: Db,
  taskId: string,
  args: {
    mode: string;
    branch: string | null;
    rootPath: string | null | undefined;
    /** The in-place execution's recorded base (execution.json), when known. */
    baseBranchHint?: string | null;
  },
): TaskGitContext | null {
  const rootPath = args.rootPath;
  if (!rootPath || !isGitRepo(rootPath)) return null;
  const now = Date.now();

  if (args.mode === "apply_in_place" || !args.branch) {
    const ctx: TaskGitContext = {
      kind: "direct",
      branch: null,
      baseBranch: currentBranch(rootPath) ?? detectBaseBranch(rootPath),
      deliveryCommit: git(["rev-parse", "HEAD"], rootPath).stdout || null,
      merged: "merged", // applied directly — there is no merge left to do
      mergedVia: null,
      checkedAt: now,
    };
    setTaskGitContext(db, taskId, ctx);
    return ctx;
  }

  const branch = args.branch;
  const commit = localBranchExists(rootPath, branch)
    ? git(["rev-parse", `refs/heads/${branch}`], rootPath).stdout || null
    : null;
  // Base = the in-place run's recorded base, else the branch the repo sits on (what
  // mergeTask would merge into) — but never the task branch itself (failed restore).
  const current = currentBranch(rootPath);
  const base =
    args.baseBranchHint ?? (current && current !== branch ? current : detectBaseBranch(rootPath));
  const ctx: TaskGitContext = {
    kind: "branch",
    branch,
    baseBranch: base,
    deliveryCommit: commit,
    merged: "unmerged",
    mergedVia: null,
    checkedAt: now,
  };
  setTaskGitContext(db, taskId, ctx);
  return ctx;
}

/** Flip a task's context to merged when Cadence's own Merge button did it. Creates a
 *  minimal context for pre-feature tasks that never had one. */
export function markTaskMergedByCadence(db: Db, taskId: string): TaskGitContext | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  const rootPath = task.projectId ? getProjectById(db, task.projectId)?.rootPath : null;
  const repoOk = !!rootPath && isGitRepo(rootPath);
  const base = repoOk ? (currentBranch(rootPath as string) ?? task.gitContext?.baseBranch ?? null) : (task.gitContext?.baseBranch ?? null);
  const prior = task.gitContext;
  if (prior?.merged === "merged") return prior;
  const ctx: TaskGitContext = {
    kind: prior?.kind ?? "branch",
    branch: prior?.branch ?? branchName(task),
    baseBranch: base,
    deliveryCommit: prior?.deliveryCommit ?? null,
    merged: "merged",
    mergedVia: "cadence",
    checkedAt: Date.now(),
  };
  setTaskGitContext(db, taskId, ctx);
  return ctx;
}

/** Forge lookup seam: PR/MR url → its state, injectable for tests. */
export type PrStateLookup = (prUrl: string) => PrState | null;

const defaultPrState: PrStateLookup = (prUrl) => {
  const ref = parsePrUrl(prUrl);
  return ref ? lookupPrState(ref) : null;
};

export interface GitContextCheck {
  context: TaskGitContext;
  changed: boolean;
}

/**
 * One deterministic re-check of a task's git context, most-reliable signal first:
 * commit ancestry (catches real merges), the forge's PR/MR state (catches
 * squash/rebase merges ancestry can't see), patch equivalence while the branch
 * still exists, and finally "branch gone" surfaced honestly rather than guessed.
 * Persists (+ timeline event) only when something actually changed — unless
 * `persist` forces a write so a manual re-check always refreshes `checkedAt`.
 */
export function checkTaskGitContext(
  db: Db,
  taskId: string,
  deps: { prState?: PrStateLookup; persist?: boolean } = {},
): GitContextCheck | null {
  const task = getTask(db, taskId);
  if (!task || !task.projectId) return null;
  const project = getProjectById(db, task.projectId);
  const rootPath = project?.rootPath;

  // Backfill: a delivered task from before git context existed gets one from delivery.md.
  let ctx = task.gitContext;
  if (!ctx) {
    const delivery = readDelivery(taskId);
    if (!delivery) return null;
    ctx = {
      kind: delivery.mode === "apply_in_place" || !delivery.branch ? "direct" : "branch",
      branch: delivery.branch,
      baseBranch: null,
      deliveryCommit: null,
      merged: delivery.mode === "apply_in_place" || !delivery.branch ? "merged" : "unmerged",
      mergedVia: null,
      checkedAt: Date.now(),
    };
    if (ctx.kind === "direct") {
      if (rootPath && isGitRepo(rootPath)) ctx.baseBranch = currentBranch(rootPath) ?? detectBaseBranch(rootPath);
      setTaskGitContext(db, taskId, ctx);
      return { context: ctx, changed: true };
    }
  }

  if (ctx.kind === "direct" || ctx.merged === "merged") return { context: ctx, changed: false };
  if (!rootPath || !isGitRepo(rootPath)) return { context: ctx, changed: false };

  const next: TaskGitContext = { ...ctx, checkedAt: Date.now() };
  if (!next.baseBranch) next.baseBranch = detectBaseBranch(rootPath);

  const branchExists = next.branch ? localBranchExists(rootPath, next.branch) : false;
  if (!next.deliveryCommit && next.branch && branchExists) {
    next.deliveryCommit = git(["rev-parse", `refs/heads/${next.branch}`], rootPath).stdout || null;
  }

  const base = next.baseBranch && localBranchExists(rootPath, next.baseBranch) ? next.baseBranch : null;
  if (
    base &&
    next.deliveryCommit &&
    git(["merge-base", "--is-ancestor", next.deliveryCommit, base], rootPath).ok
  ) {
    next.merged = "merged";
    next.mergedVia = "external";
  } else if (task.prUrl && (deps.prState ?? defaultPrState)(task.prUrl) === "merged") {
    next.merged = "merged";
    next.mergedVia = "forge";
  } else if (base && next.branch && branchExists && cherryEquivalent(rootPath, base, next.branch)) {
    next.merged = "merged"; // squash/rebase-merged: every patch has an equivalent in base
    next.mergedVia = "external";
  } else if (next.branch && !branchExists) {
    // The branch vanished without its commit reaching base — say so, don't guess.
    next.merged = next.deliveryCommit ? "branch_gone" : "unknown";
  } else if (!next.branch || !base) {
    next.merged = "unknown";
  } else {
    next.merged = "unmerged";
  }

  const changed =
    next.merged !== ctx.merged ||
    next.mergedVia !== ctx.mergedVia ||
    next.baseBranch !== ctx.baseBranch ||
    next.deliveryCommit !== ctx.deliveryCommit;
  if (changed || deps.persist) {
    setTaskGitContext(db, taskId, next);
    if (changed) recordEvent(db, { taskId, type: "git_context_changed", payload: next });
  }
  return { context: next, changed };
}

// ------------------------------------------------------------------ background sweep

/** Only tasks whose merge state can still change get re-checked. */
const SWEEP_STATUSES = ["review", "done"] as const;
/** Stop auto-checking tasks untouched for a month — the manual Re-check button remains. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * One sweep pass: re-check every review/done task with (potentially) unmerged work.
 * A change broadcasts `task:updated` (the web app refetches) and a newly-detected
 * external merge notifies — on a review task it nudges "open it to mark done"
 * (propose, don't impose: the status never flips silently).
 */
export function sweepGitContexts(
  db: Db,
  hub: WsHub,
  deps: { prState?: PrStateLookup; now?: () => number } = {},
): { checked: number; changed: number } {
  const now = deps.now?.() ?? Date.now();
  let checked = 0;
  let changed = 0;
  for (const status of SWEEP_STATUSES) {
    for (const task of listTasks(db, { status })) {
      if (!task.projectId) continue;
      if (now - task.updatedAt > MAX_AGE_MS) continue;
      const ctx = task.gitContext;
      if (ctx && (ctx.kind === "direct" || ctx.merged === "merged")) continue;
      const result = checkTaskGitContext(db, task.id, { prState: deps.prState });
      if (!result) continue;
      checked++;
      if (!result.changed) continue;
      changed++;
      hub.broadcast({ type: "event", name: "task:updated", payload: task.id });
      if (result.context.merged === "merged") {
        notifyGitMergedExternally(hub, task, result.context);
      }
    }
  }
  return { checked, changed };
}

/** Start the periodic git-context sweep. Returns a handle with close().
 *  CADENCE_GIT_CONTEXT_MS overrides the 5-min default (tests, impatient users). */
export function startGitContextSweep(
  db: Db,
  hub: WsHub,
  opts: { intervalMs?: number; prState?: PrStateLookup } = {},
): { close: () => void } {
  const env = Number(process.env.CADENCE_GIT_CONTEXT_MS);
  const interval =
    opts.intervalMs ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_INTERVAL_MS);
  const timer = setInterval(() => {
    try {
      sweepGitContexts(db, hub, { prState: opts.prState });
    } catch (err) {
      console.error("[cadence] git-context sweep failed:", err);
    }
  }, interval);
  if (typeof timer.unref === "function") timer.unref();
  return { close: () => clearInterval(timer) };
}
