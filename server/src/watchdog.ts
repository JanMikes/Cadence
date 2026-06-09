import { statSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { sessions } from "./db/schema";
import { isSessionRowAlive, killProcessTree, type LivenessProbe, REAL_PROBE } from "./liveness";
import { notifyOnTransition } from "./notify";
import { taskDiff } from "./review";
import { endSession, listSessions } from "./sessions";
import { appendContext, readPlan } from "./store/store";
import { getTask, listTasks, updateTask } from "./tasks";
import { resolveTranscriptPath } from "./transcripts";
import type { WsHub } from "./ws";

/**
 * Session/run health — the safety net that guarantees a run is never silently "dead"
 * (spec §10: visible system status). Two layers:
 *
 *   1. reconcileOrphans (startup): a previous gateway's child processes can't survive a
 *      restart, so every session still marked running/spawning is dead. End them and
 *      rescue any task stranded mid-execution → a visible, actionable state.
 *   2. startSessionWatchdog (periodic): at runtime, detect sessions whose process has
 *      died (→ end + rescue) or that have gone idle far too long (→ surface a nudge).
 *
 * Both are deterministic (pid liveness + transcript mtime) — cheap and reliable, no agent
 * spawn required. A task in an active-work state therefore always has either a live run
 * (spinner) or a surfaced "needs you" reason — never invisible limbo.
 *
 * Liveness is the HONEST verdict from liveness.ts (§6.1.d): kill(0) alone kept 17
 * defunct zombies "running" for 15+ hours — a defunct or pid-recycled process is dead
 * here, so the periodic pass doubles as the sweep that finalizes lying rows.
 */

const ACTIVE_WORK: ReadonlySet<string> = new Set(["implementing", "verifying"]);
const RUNNING: ReadonlySet<string> = new Set(["spawning", "running"]);

/** How long a still-"running" session may go without writing its transcript before we flag it. */
export const STUCK_IDLE_MS = Number(process.env.CADENCE_SESSION_STUCK_MS) || 10 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

// Re-exported so existing imports keep working; the implementation lives with the
// other session-liveness helpers.
export { isProcessAlive } from "./sessions";

/** Most recent sign of life for a session: its transcript's mtime, else when it started. */
function lastActivityMs(
  db: Db,
  session: { id: string; cwd: string; transcriptPath: string | null; startedAt: number | null },
): number {
  let t = session.startedAt ?? 0;
  // Resolve (and self-heal) the real on-disk transcript — a stale path must not
  // make a busily-writing run look idle.
  const path = resolveTranscriptPath(session, (fixed) => {
    db.update(sessions).set({ transcriptPath: fixed }).where(eq(sessions.id, session.id)).run();
  });
  if (path) {
    try {
      const m = statSync(path).mtimeMs;
      if (m > t) t = m;
    } catch {
      // transcript not written yet — fall back to startedAt
    }
  }
  return t;
}

/**
 * Move a task stranded in an active-work state (implementing/verifying) to a visible,
 * actionable place: Review if the worktree has changes (inspect/merge), Plan review if a
 * plan exists (re-approve to retry), else Ready (re-PLAY). Always notifies. No-op if the
 * task isn't actually stranded. Returns true if it moved.
 */
export function recoverStrandedTask(db: Db, hub: WsHub, taskId: string, reason: string): boolean {
  const task = getTask(db, taskId);
  if (!task || !ACTIVE_WORK.has(task.status)) return false;

  let target = "ready";
  let hasDiff = false;
  try {
    hasDiff = (taskDiff(db, taskId).diff ?? "").trim().length > 0;
  } catch {
    hasDiff = false;
  }
  if (hasDiff) target = "review";
  else if (readPlan(taskId).steps.length > 0) target = "plan_review";

  try {
    appendContext(taskId, `Auto-recovered: ${reason}. Moved ${task.status} → ${target}.`);
  } catch {
    // context is best-effort
  }
  const updated = updateTask(db, taskId, { status: target });
  hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
  // Notify with the natural per-state message; fall back to an explicit nudge for Ready
  // (which has no transition notification) so a recovery is never silent.
  const sent = updated ? notifyOnTransition(hub, task.status, updated) : null;
  if (!sent && updated) {
    hub.broadcast({
      type: "event",
      name: "notify",
      payload: {
        kind: "stalled",
        title: "Recovered a stalled task",
        message: `${updated.title} — moved to ${target}`,
        taskId,
      },
    });
  }
  return true;
}

/**
 * Startup reconciliation — runs regardless of autonomy (a correctness concern). Ends every
 * still-running session whose process is actually gone and rescues stranded tasks.
 *
 * Orphaned ONE-SHOTS that did survive the restart are KILLED, not adopted (§6.1.e): their
 * driving promise died with the old gateway, so even a completed run could never apply its
 * result to the task — it would only burn tokens and then die on SIGPIPE anyway. The
 * budgeted heal (which runs after this) decides whether to retry. Warm chats are different:
 * they keep their honest "running" status — output still streams from the transcript and
 * Stop/Kill/terminal-takeover work by pid.
 * Returns the number of sessions reconciled.
 */
export function reconcileOrphans(db: Db, hub: WsHub, probe: LivenessProbe = REAL_PROBE): number {
  let ended = 0;
  const aliveTasks = new Set<string>();
  for (const s of listSessions(db)) {
    if (!RUNNING.has(s.status)) continue;
    if (s.pid != null && isSessionRowAlive(s, probe)) {
      if (s.kind !== "oneshot") {
        if (s.taskId) aliveTasks.add(s.taskId);
        continue; // a warm chat survived the restart — still genuinely (and usefully) running
      }
      killProcessTree(s.pid, { probe });
      endSession(db, s.id, "killed");
      hub.broadcast({ type: "event", name: "session:updated", payload: s.id });
      ended += 1;
      if (s.taskId) {
        recoverStrandedTask(db, hub, s.taskId, `the ${s.role} run from before a restart was stopped (its result could no longer be used)`);
      }
      continue;
    }
    endSession(db, s.id, "failed");
    hub.broadcast({ type: "event", name: "session:updated", payload: s.id });
    ended += 1;
    if (s.taskId) recoverStrandedTask(db, hub, s.taskId, `the ${s.role} run was interrupted by an app restart`);
  }
  // Belt-and-suspenders: any task still in an active-work state without a surviving run is
  // stranded even if its session row was already cleaned up.
  for (const status of ACTIVE_WORK) {
    for (const t of listTasks(db, { status })) {
      if (aliveTasks.has(t.id)) continue;
      recoverStrandedTask(db, hub, t.id, "its run did not survive an app restart");
    }
  }
  return ended;
}

/**
 * One watchdog pass. Dead sessions (pid known + gone) → end + rescue task. Suspected-stuck
 * sessions (running but idle past the threshold, can't confirm dead) → surface a one-time
 * nudge but DON'T kill (a long build could look idle). `notified` dedupes the nudges.
 */
export function checkSessions(
  db: Db,
  hub: WsHub,
  notified: Set<string>,
  now: number = Date.now(),
  probe: LivenessProbe = REAL_PROBE,
): { dead: number; stuck: number } {
  let dead = 0;
  let stuck = 0;
  for (const s of listSessions(db)) {
    if (!RUNNING.has(s.status)) continue;

    // Honest sweep (§6.1.d): dead, defunct-zombie and pid-recycled runs all finalize
    // here — including rows that never got a pid (gateway died between insert and
    // spawn) once they age past the pre-spawn grace.
    if (!isSessionRowAlive(s, { ...probe, now: () => now })) {
      endSession(db, s.id, "failed");
      hub.broadcast({ type: "event", name: "session:updated", payload: s.id });
      dead += 1;
      const recovered = s.taskId
        ? recoverStrandedTask(db, hub, s.taskId, `the ${s.role} session ended unexpectedly`)
        : false;
      if (!recovered) {
        hub.broadcast({
          type: "event",
          name: "notify",
          payload: {
            kind: "stalled",
            title: "Session ended unexpectedly",
            message: `The ${s.role} session stopped without finishing.`,
            taskId: s.taskId ?? undefined,
          },
        });
      }
      notified.delete(s.id);
      continue;
    }

    const lastActivity = lastActivityMs(db, s);
    if (now - lastActivity > STUCK_IDLE_MS && !notified.has(s.id)) {
      notified.add(s.id);
      stuck += 1;
      const mins = Math.round((now - lastActivity) / 60_000);
      hub.broadcast({
        type: "event",
        name: "notify",
        payload: {
          kind: "stalled",
          title: "A run looks stuck",
          message: `The ${s.role} session has had no activity for ~${mins} min — open it to check.`,
          taskId: s.taskId ?? undefined,
        },
      });
    }
  }
  return { dead, stuck };
}

/** Start the periodic session watchdog. Returns a handle with close(). */
export function startSessionWatchdog(
  db: Db,
  hub: WsHub,
  opts: { intervalMs?: number } = {},
): { close: () => void } {
  const notified = new Set<string>();
  const timer = setInterval(() => {
    try {
      checkSessions(db, hub, notified);
    } catch (err) {
      console.error("[cadence] session watchdog failed:", err);
    }
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return { close: () => clearInterval(timer) };
}
