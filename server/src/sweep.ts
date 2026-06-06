import type { SweepFinding, SweepReport } from "@cadence/shared";
import type { Db } from "./db/client";
import { listTasks } from "./tasks";
import type { WsHub } from "./ws";

/**
 * Background sweep (spec §8): scan for proactive nudges — tasks idling too long
 * and deadlines at risk. Pure + now-injected; the scheduler below runs it on an
 * interval. Propose-don't-impose: it surfaces findings, never acts on them.
 */
const DAY = 86_400_000;
const CLOSED = new Set(["done", "cancelled"]);

export interface SweepOptions {
  staleDays?: number; // idle threshold (default 7)
  atRiskDays?: number; // deadline lookahead (default 2; overdue always included)
}

export function runSweep(db: Db, now: number, opts: SweepOptions = {}): SweepReport {
  const staleDays = opts.staleDays ?? 7;
  const atRiskDays = opts.atRiskDays ?? 2;
  const findings: SweepFinding[] = [];

  for (const t of listTasks(db)) {
    if (CLOSED.has(t.status)) continue;

    // Deadline risk takes precedence over staleness (one finding per task).
    if (t.deadline != null && t.deadline <= now + atRiskDays * DAY) {
      const days = Math.round((t.deadline - now) / DAY);
      const detail = days < 0 ? `Overdue by ${Math.abs(days)}d` : days === 0 ? "Due today" : `Due in ${days}d`;
      findings.push({ kind: "at_risk", taskId: t.id, title: t.title, status: t.status, detail });
      continue;
    }
    const idleDays = Math.floor((now - t.updatedAt) / DAY);
    if (idleDays >= staleDays) {
      findings.push({
        kind: "stale",
        taskId: t.id,
        title: t.title,
        status: t.status,
        detail: `Idle ${idleDays}d in ${t.status}`,
      });
    }
  }

  return { ranAt: now, findings };
}

export interface SweepHandle {
  close(): void;
}

/**
 * Start the periodic sweep. Disabled (no-op) unless an interval is given via
 * opts.intervalMs or $CADENCE_SWEEP_MS — so tests + the default install don't
 * run a timer. Each tick broadcasts a `sweep:ran` event with the finding count.
 */
export function startSweep(
  db: Db,
  hub: WsHub,
  opts: SweepOptions & { intervalMs?: number; onTick?: () => void } = {},
): SweepHandle {
  const intervalMs = opts.intervalMs ?? Number(process.env.CADENCE_SWEEP_MS ?? 0);
  if (!intervalMs || intervalMs <= 0) return { close() {} };
  const timer = setInterval(() => {
    const report = runSweep(db, Date.now(), opts);
    hub.broadcast({ type: "event", name: "sweep:ran", payload: report.findings.length });
    opts.onTick?.(); // proactive-proposal emission hook (5.4)
  }, intervalMs);
  return {
    close() {
      clearInterval(timer);
    },
  };
}
