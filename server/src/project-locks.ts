import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "./db/client";
import { sessions } from "./db/schema";
import { getProjectById } from "./projects";
import { getTask } from "./tasks";

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
 * queued execution isn't starved by a stream of captures. A DB guard catches
 * the one cross-process case: claude children can outlive a gateway restart
 * (watchdog keeps their session rows honest), so acquisition also waits for
 * live in-place execution sessions recorded by a previous process.
 */

export type Release = () => void;

interface Waiter {
  kind: "read" | "write";
  resolve: (release: Release) => void;
}

interface LockState {
  readers: number;
  writer: boolean;
  queue: Waiter[];
}

/** DB guard inputs: how to recognize a live in-place execution from a previous process. */
export interface SurvivorGuard {
  db: Db;
  /** The project's rootPath — in-place execution sessions run exactly there. */
  rootPath: string;
  /** Our own task's runs don't block us (re-entry after a failed verify, resume). */
  excludeTaskId?: string;
}

const EXECUTION_ROLES = ["implementer", "verifier", "delivery"];
const LIVE_STATUSES = ["spawning", "running"];

export class ProjectLocks {
  private readonly locks = new Map<string, LockState>();

  constructor(private readonly pollMs: number = 2_000) {}

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
    if (guard) await this.awaitNoSurvivors(guard, projectId);
    return release;
  }

  /** Exclusive access for an in-place execution. Waits for active readers to drain and
   *  blocks new ones (writer preference). With a guard, also waits out any in-place
   *  execution session left live by a previous gateway process. `onQueued` fires once
   *  if the lock isn't immediately available — the caller surfaces the wait. */
  async acquireWrite(
    projectId: string | null | undefined,
    opts: { guard?: SurvivorGuard; onQueued?: () => void } = {},
  ): Promise<Release> {
    if (!projectId) return () => {};
    let queued = false;
    const notifyQueued = (): void => {
      if (!queued) {
        queued = true;
        opts.onQueued?.();
      }
    };
    const release = await new Promise<Release>((resolve) => {
      const s = this.state(projectId);
      if (!s.writer && s.readers === 0) {
        s.writer = true;
        resolve(this.writeRelease(projectId));
      } else {
        notifyQueued();
        s.queue.push({ kind: "write", resolve });
      }
    });
    if (opts.guard) {
      if (this.liveSurvivors(opts.guard, projectId).length > 0) notifyQueued();
      await this.awaitNoSurvivors(opts.guard, projectId);
    }
    return release;
  }

  /** Is an in-place execution holding (in-memory) or surviving (DB) this project? */
  isWriteBusy(projectId: string, guard?: SurvivorGuard): boolean {
    const s = this.locks.get(projectId);
    if (s?.writer) return true;
    return guard ? this.liveSurvivors(guard).length > 0 : false;
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
      this.drain(projectId);
    };
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

  /** Live in-place execution sessions (oneshot implementer/verifier/delivery running in
   *  the project rootPath) that don't belong to `excludeTaskId`. */
  private liveSurvivors(guard: SurvivorGuard, projectId?: string): { id: string }[] {
    const conditions = [
      eq(sessions.kind, "oneshot"),
      inArray(sessions.role, EXECUTION_ROLES),
      inArray(sessions.status, LIVE_STATUSES),
      eq(sessions.cwd, guard.rootPath),
    ];
    if (projectId) conditions.push(eq(sessions.projectId, projectId));
    if (guard.excludeTaskId) conditions.push(ne(sessions.taskId, guard.excludeTaskId));
    return guard.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(...conditions))
      .all();
  }

  /** Poll until no survivor session is live. The watchdog ends dead-pid rows within its
   *  tick, and a genuinely-alive survivor is exactly what we must wait for. */
  private async awaitNoSurvivors(guard: SurvivorGuard, projectId: string): Promise<void> {
    while (this.liveSurvivors(guard, projectId).length > 0) {
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
