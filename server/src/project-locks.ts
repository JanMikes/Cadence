import { and, eq, inArray } from "drizzle-orm";
import type { LiveSession, LockBlocker } from "@cadence/shared";
import type { Db } from "./db/client";
import { sessions } from "./db/schema";
import { getProjectById } from "./projects";
import { getTask } from "./tasks";
import { readLiveSessions } from "./transcripts";

/**
 * Per-project readers-writer lock (§9): coordinates who may use a project's
 * working directory when executions run IN it (worktrees disabled, or
 * apply_in_place). Read stages (triage/discovery/questioner/planner) share the
 * tree; an in-place execution (implementer→verifier→delivery) is exclusive —
 * one implementation per project at a time, and investigations always see the
 * repo on its base branch, never a half-written task branch. Worktree-isolated
 * executions never take the write lock, so they stay fully parallel.
 *
 * In-memory (all stage runs live in this process) with writer preference, so a
 * queued execution isn't starved by a stream of captures. The memory lock only
 * sees THIS process, so acquisition also waits out everything it can't own:
 *  - execution sessions left live by a previous gateway process (claude
 *    children outlive a restart; the watchdog keeps their rows honest),
 *  - and, for EXCLUSIVE acquisitions (guard.exclusive), every other live
 *    occupant of the working dir: warm chat sessions Cadence spawned there and
 *    external claude processes from the ~/.claude liveness oracle. An
 *    autonomous run must never mutate a dir someone else is working in — not
 *    even someone outside Cadence.
 */

export type Release = () => void;

interface Waiter {
  kind: "read" | "write";
  resolve: (release: Release) => void;
  /** Who this waiter is (writers only) — becomes `writerLabel` when admitted. */
  label?: string;
  /** The waiter's task — becomes `writerTaskId` when admitted. */
  taskId?: string;
}

interface LockState {
  readers: number;
  writer: boolean;
  queue: Waiter[];
  /** Who holds the writer slot — so a queued task can be told WHAT it waits for. */
  writerLabel?: string;
  /** The holder's task id — so the queued task's UI can link straight to it. */
  writerTaskId?: string;
}

/** DB/oracle guard inputs: how to recognize live occupants of the project dir. */
export interface SurvivorGuard {
  db: Db;
  /** The project's rootPath — in-place sessions run exactly there. */
  rootPath: string;
  /** Our own task's pipeline runs don't block us (re-entry after a failed
   *  verify, resume). Only oneshot stage rows are excluded — a live warm chat,
   *  even on the same task, is a real occupant. */
  excludeTaskId?: string;
  /** The acquirer will MUTATE the dir: block on ANY live occupant (warm chat
   *  sessions, external claude processes), not just execution survivors. Read
   *  stages leave this unset — they only queue behind executions. */
  exclusive?: boolean;
}

/** A reason the project dir is occupied — shown to the user, never swallowed.
 *  Shared with the web (shared/src/index.ts): label + ids for deep-linking. */
export type { LockBlocker };

const EXECUTION_ROLES = ["implementer", "verifier", "delivery"];
const LIVE_STATUSES = ["spawning", "running"];

/** Is `cwd` the project root or inside it? (Worktrees live in a SIBLING
 *  `.cadence-worktrees` dir, so isolated runs never match.) */
function withinRoot(cwd: string, rootPath: string): boolean {
  if (!cwd || !rootPath) return false;
  const root = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
  return cwd === root || cwd.startsWith(`${root}/`);
}

export class ProjectLocks {
  private readonly locks = new Map<string, LockState>();

  constructor(
    private readonly pollMs: number = 2_000,
    /** Injectable for tests: the ~/.claude liveness oracle (external sessions). */
    private readonly oracle: () => LiveSession[] = readLiveSessions,
  ) {}

  /** Shared access for read-only stages. Resolves immediately when no execution holds
   *  (or awaits) the project; a null projectId is a no-op (nothing to protect). */
  async acquireRead(projectId: string | null | undefined, guard?: SurvivorGuard): Promise<Release> {
    if (!projectId) return () => {};
    const release = await new Promise<Release>((resolve) => {
      const s = this.state(projectId);
      const queuedWriter = s.queue.some((w) => w.kind === "write");
      if (!s.writer && !queuedWriter) {
        s.readers += 1;
        resolve(this.readRelease(projectId));
      } else {
        s.queue.push({ kind: "read", resolve });
      }
    });
    if (guard) await this.awaitNoBlockers(guard);
    return release;
  }

  /** Exclusive access for an in-place execution. Waits for active readers to drain and
   *  blocks new ones (writer preference). With a guard, also waits out every live
   *  occupant of the working dir (see SurvivorGuard.exclusive). `onQueued` fires once
   *  if the lock isn't immediately available — the caller surfaces the wait, including
   *  WHO is blocking (no silent queueing). */
  async acquireWrite(
    projectId: string | null | undefined,
    opts: {
      guard?: SurvivorGuard;
      onQueued?: (blockers: LockBlocker[]) => void;
      /** Who we are (e.g. `the task “Fix login”`) — told to whoever queues behind us. */
      label?: string;
      /** Our task id — lets whoever queues behind us link straight to the task. */
      taskId?: string;
    } = {},
  ): Promise<Release> {
    if (!projectId) return () => {};
    let queued = false;
    const notifyQueued = (blockers: LockBlocker[]): void => {
      if (!queued) {
        queued = true;
        opts.onQueued?.(blockers);
      }
    };
    const release = await new Promise<Release>((resolve) => {
      const s = this.state(projectId);
      if (!s.writer && s.readers === 0) {
        s.writer = true;
        s.writerLabel = opts.label;
        s.writerTaskId = opts.taskId;
        resolve(this.writeRelease(projectId));
      } else {
        notifyQueued([this.holderBlocker(s)]);
        s.queue.push({ kind: "write", resolve, label: opts.label, taskId: opts.taskId });
      }
    });
    if (opts.guard) {
      const blockers = this.listBlockers(opts.guard);
      if (blockers.length > 0) notifyQueued(blockers);
      await this.awaitNoBlockers(opts.guard);
    }
    return release;
  }

  /** Grab the write slot only if it's free RIGHT NOW (no waiting) — for short
   *  user-driven mutations like merge, so they can't race a granted execution
   *  (the probe-then-act TOCTOU). Tolerates active READERS by design: read
   *  stages have always coexisted with user-driven tree changes, and blocking a
   *  merge on a minutes-long investigation would be a regression. Returns null
   *  when an execution holds, awaits, or survives on the project. */
  tryAcquireWrite(
    projectId: string | null | undefined,
    guard?: SurvivorGuard,
    label?: string,
  ): Release | null {
    if (!projectId) return () => {};
    const s = this.locks.get(projectId);
    if (s?.writer || s?.queue.some((w) => w.kind === "write")) return null;
    if (guard && this.listBlockers(guard).length > 0) return null;
    const state = this.state(projectId);
    state.writer = true;
    state.writerLabel = label;
    state.writerTaskId = undefined;
    return this.writeRelease(projectId);
  }

  /** Is an in-place execution holding (in-memory) or surviving (DB) this project? */
  isWriteBusy(projectId: string, guard?: SurvivorGuard): boolean {
    const s = this.locks.get(projectId);
    if (s?.writer) return true;
    return guard ? this.listBlockers(guard).length > 0 : false;
  }

  /** The current occupants a guard would wait for — for actionable messages. */
  blockersFor(guard: SurvivorGuard): LockBlocker[] {
    return this.listBlockers(guard);
  }

  // ----------------------------------------------------------------- internals

  private state(projectId: string): LockState {
    let s = this.locks.get(projectId);
    if (!s) {
      s = { readers: 0, writer: false, queue: [] };
      this.locks.set(projectId, s);
    }
    return s;
  }

  private readRelease(projectId: string): Release {
    let released = false;
    return () => {
      if (released) return; // idempotent — a finally + an error path may both call it
      released = true;
      const s = this.state(projectId);
      s.readers = Math.max(0, s.readers - 1);
      this.drain(projectId);
    };
  }

  private writeRelease(projectId: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const s = this.state(projectId);
      s.writer = false;
      s.writerLabel = undefined;
      s.writerTaskId = undefined;
      this.drain(projectId);
    };
  }

  /** Why an in-memory acquisition can't be granted right now, as a blocker. */
  private holderBlocker(s: LockState): LockBlocker {
    if (s.writer) {
      return {
        kind: "execution",
        label: s.writerLabel ?? "another task executing in this project",
        ...(s.writerTaskId ? { taskId: s.writerTaskId } : {}),
      };
    }
    return { kind: "execution", label: "investigation stages reading the project dir" };
  }

  /** Admit the queue head: a writer once readers drain, else every reader up to the
   *  next queued writer. Drops the state entry when fully idle (no leak). */
  private drain(projectId: string): void {
    const s = this.locks.get(projectId);
    if (!s) return;
    while (s.queue.length > 0) {
      const head = s.queue[0] as Waiter;
      if (head.kind === "write") {
        if (s.writer || s.readers > 0) break;
        s.queue.shift();
        s.writer = true;
        s.writerLabel = head.label;
        s.writerTaskId = head.taskId;
        head.resolve(this.writeRelease(projectId));
        break; // exclusive — nothing else can be admitted
      }
      if (s.writer) break;
      s.queue.shift();
      s.readers += 1;
      head.resolve(this.readRelease(projectId));
    }
    if (!s.writer && s.readers === 0 && s.queue.length === 0) this.locks.delete(projectId);
  }

  /**
   * Every live occupant of the project dir this guard must wait for:
   *  - Cadence session rows (DB) that are live in the rootPath — execution
   *    survivors always count; with `exclusive`, ANY live session counts
   *    (a warm chat editing under an implementer is the same hazard as a
   *    second implementer). Exclusion (re-entry) is applied in JS, not SQL:
   *    `ne(taskId, x)` silently drops NULL-taskId rows in three-valued logic.
   *  - with `exclusive`, alive external claude processes (the ~/.claude
   *    liveness oracle) whose cwd is the rootPath or inside it, unless the
   *    session id is one of ours (its DB row already speaks for it).
   */
  private listBlockers(guard: SurvivorGuard): LockBlocker[] {
    const rows = guard.db
      .select({ id: sessions.id, taskId: sessions.taskId, kind: sessions.kind, role: sessions.role })
      .from(sessions)
      .where(and(inArray(sessions.status, LIVE_STATUSES), eq(sessions.cwd, guard.rootPath)))
      .all();
    const blockers: LockBlocker[] = [];
    for (const r of rows) {
      if (guard.excludeTaskId && r.taskId === guard.excludeTaskId && r.kind === "oneshot") continue;
      const isExecution = r.kind === "oneshot" && EXECUTION_ROLES.includes(r.role ?? "");
      // Name the task, not the session id — "waiting for the task “Fix login”" is
      // something the user can act on; a session hash is not.
      const title = r.taskId ? getTask(guard.db, r.taskId)?.title : null;
      // Ids ride along with the label so the UI can open the blocker, not just name it.
      const ids = { sessionId: r.id, ...(r.taskId ? { taskId: r.taskId } : {}) };
      if (isExecution) {
        blockers.push({
          kind: "execution",
          label: title ? `the task “${title}” (${r.role})` : `a ${r.role} run (session ${r.id.slice(0, 8)})`,
          ...ids,
        });
      } else if (guard.exclusive) {
        blockers.push({
          kind: "session",
          label: title
            ? `a live ${r.role ?? "chat"} session on “${title}”`
            : `a live ${r.role ?? "chat"} session (${r.id.slice(0, 8)})`,
          ...ids,
        });
      }
    }
    if (guard.exclusive) {
      const knownIds = new Set(
        guard.db
          .select({ id: sessions.id })
          .from(sessions)
          .all()
          .map((r) => r.id),
      );
      for (const ls of this.oracle()) {
        if (!ls.alive) continue;
        if (!withinRoot(ls.cwd, guard.rootPath)) continue;
        if (ls.sessionId && knownIds.has(ls.sessionId)) continue;
        blockers.push({
          kind: "external",
          label: `a Claude Code session outside Cadence (pid ${ls.pid}, ${ls.cwd})`,
          pid: ls.pid,
          cwd: ls.cwd,
          ...(ls.sessionId ? { sessionId: ls.sessionId } : {}),
        });
      }
    }
    return blockers;
  }

  /** Poll until no occupant is live. The watchdog ends dead-pid rows within its tick,
   *  the oracle drops files when external sessions exit, and a genuinely-alive
   *  occupant is exactly what we must wait for. */
  private async awaitNoBlockers(guard: SurvivorGuard): Promise<void> {
    while (this.listBlockers(guard).length > 0) {
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}

/** The process-wide instance — stage runners and the API chains share one lock table. */
export const projectLocks = new ProjectLocks();

/** The survivor guard for a project — undefined when there's nothing to match against. */
export function survivorGuardFor(
  db: Db,
  projectId: string | null | undefined,
  excludeTaskId?: string,
): SurvivorGuard | undefined {
  if (!projectId) return undefined;
  const rootPath = getProjectById(db, projectId)?.rootPath;
  return rootPath ? { db, rootPath, excludeTaskId } : undefined;
}

/**
 * Run a read-only stage's agent under the project's read lock: shared with other
 * readers, queued behind an in-place execution — investigations never see a
 * half-written task branch. No-op for project-less tasks.
 */
export async function withReadAccess<T>(db: Db, taskId: string, fn: () => Promise<T>): Promise<T> {
  const projectId = getTask(db, taskId)?.projectId ?? null;
  const release = await projectLocks.acquireRead(projectId, survivorGuardFor(db, projectId, taskId));
  try {
    return await fn();
  } finally {
    release();
  }
}
