import type { AnalyticsSummary, ProjectAnalytics, ThroughputDay } from "@cadence/shared";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { events, projects, sessions, tasks } from "./db/schema";

/**
 * Cost & throughput analytics (spec §10) — derived entirely from data Cadence
 * already records: session costUsd (per project), the status_change timeline
 * (completions/day), and the task index (status breakdown). Pure read.
 */
const DAY = 86_400_000;

function dayString(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function computeAnalytics(db: Db, now: number = Date.now(), throughputDays = 14): AnalyticsSummary {
  const allTasks = db.select().from(tasks).all();
  const allSessions = db.select().from(sessions).all();
  const projectRows = db.select().from(projects).all();

  const byStatus: Record<string, number> = {};
  for (const t of allTasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  // Per-project aggregation (with an "Unassigned" bucket for null projectId).
  const name = new Map(projectRows.map((p) => [p.id, p.name]));
  const buckets = new Map<string, ProjectAnalytics>();
  const bucket = (id: string | null): ProjectAnalytics => {
    const key = id ?? "__none__";
    let b = buckets.get(key);
    if (!b) {
      b = {
        projectId: id,
        projectName: id ? (name.get(id) ?? "(unknown)") : "Unassigned",
        tasks: 0,
        done: 0,
        sessions: 0,
        costUsd: 0,
      };
      buckets.set(key, b);
    }
    return b;
  };
  for (const t of allTasks) {
    const b = bucket(t.projectId);
    b.tasks++;
    if (t.status === "done") b.done++;
  }
  for (const s of allSessions) {
    const b = bucket(s.projectId);
    b.sessions++;
    b.costUsd += s.costUsd;
  }
  const byProject = [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd || b.tasks - a.tasks);

  // Throughput: completions per day (status_change → done) over the window.
  const sinceMs = now - (throughputDays - 1) * DAY;
  const completions = new Map<string, number>();
  for (let i = 0; i < throughputDays; i++) completions.set(dayString(sinceMs + i * DAY), 0);
  for (const e of db.select().from(events).where(eq(events.type, "status_change")).all()) {
    if (e.createdAt < sinceMs) continue;
    let to: unknown;
    try {
      to = e.payload ? (JSON.parse(e.payload) as { to?: unknown }).to : undefined;
    } catch {
      to = undefined;
    }
    if (to !== "done") continue;
    const key = dayString(e.createdAt);
    if (completions.has(key)) completions.set(key, (completions.get(key) ?? 0) + 1);
  }
  const throughput: ThroughputDay[] = [...completions.entries()].map(([date, completed]) => ({
    date,
    completed,
  }));

  return {
    totalCostUsd: byProject.reduce((sum, p) => sum + p.costUsd, 0),
    totalSessions: allSessions.length,
    totalTasks: allTasks.length,
    doneTasks: byStatus.done ?? 0,
    byStatus,
    byProject,
    throughput,
  };
}
