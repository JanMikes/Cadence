import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";
import { isSessionRowAlive, type LivenessProbe, REAL_PROBE } from "../liveness";

/**
 * DB-level in-flight dedupe for pipeline stage runs (plan §6.1.b) — the fix for the
 * runaway-discovery incident: 15+ agents spawned for one task because the only guard
 * was in-memory (empty after every `bun --watch` re-exec) and liveness trusted
 * `process.kill(pid, 0)`, which defunct zombies pass.
 *
 * The source of truth here is the sessions table: a stage may spawn only when no
 * *honestly alive* one-shot run of the same (task, role) exists (liveness.ts §6.1.d
 * defines "honestly alive": not defunct, start-time signature matches). Stale
 * leftovers (defunct zombies, dead/reused pids, rows orphaned by a restart) are
 * finalized as a side effect of the check itself, so a genuinely dead previous
 * attempt never blocks a legitimate retry.
 */

type SessionRow = typeof sessions.$inferSelect;

/** Thrown when a stage would duplicate an honestly-alive run. Callers map it to 409/skip. */
export class StageConflictError extends Error {
  readonly code = "stage_conflict";
  constructor(
    readonly taskId: string,
    readonly role: string,
    readonly sessionId: string,
  ) {
    super(`a ${role} run is already active for task ${taskId} (session ${sessionId})`);
    this.name = "StageConflictError";
  }
}

/**
 * Return the live one-shot run of (taskId, role) if one exists; finalize every stale
 * "running" leftover found on the way (status → failed, endedAt set) so zombie rows
 * retire themselves the moment anything asks.
 */
export function findLiveStage(
  db: Db,
  taskId: string,
  role: string,
  probe: LivenessProbe = REAL_PROBE,
): SessionRow | null {
  const rows = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.taskId, taskId),
        eq(sessions.role, role),
        eq(sessions.kind, "oneshot"),
        inArray(sessions.status, ["spawning", "running"]),
      ),
    )
    .all();

  let live: SessionRow | null = null;
  for (const row of rows) {
    if (isSessionRowAlive(row, probe)) {
      live ??= row;
      continue;
    }
    db.update(sessions)
      .set({ status: "failed", endedAt: probe.now() })
      .where(eq(sessions.id, row.id))
      .run();
    console.warn(`[cadence] finalized stale ${role} session ${row.id} (dead/defunct pid ${row.pid ?? "—"})`);
  }
  return live;
}

/** Guard a spawn: throws StageConflictError when a live run of (taskId, role) exists. */
export function assertStageIdle(db: Db, taskId: string, role: string, probe: LivenessProbe = REAL_PROBE): void {
  const live = findLiveStage(db, taskId, role, probe);
  if (live) throw new StageConflictError(taskId, role, live.id);
}

// --- attempt budget (§6.1.c) ------------------------------------------------

export const STAGE_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Max *automatic* spawns of one stage per task per window (a Settings knob in 6.3.e). */
export const DEFAULT_STAGE_ATTEMPT_BUDGET = 3;

/**
 * How many runs of (taskId, role) started inside the window — every outcome counts
 * (done, failed, killed): the budget bounds spawn *attempts*, i.e. money, not successes.
 * Manual, user-initiated runs may exceed the budget (they still respect the dedupe
 * above); only automatic respawn loops (heal, future sweeps) must check it.
 */
export function countRecentStageRuns(
  db: Db,
  taskId: string,
  role: string,
  windowMs: number = STAGE_ATTEMPT_WINDOW_MS,
): number {
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.taskId, taskId),
        eq(sessions.role, role),
        eq(sessions.kind, "oneshot"),
        gte(sessions.startedAt, Date.now() - windowMs),
      ),
    )
    .all().length;
}
