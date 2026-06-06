import type { Task, UrgencyTier } from "@cadence/shared";

/**
 * Deadline-aware prioritization (Principle 12 / spec §10.3): urgency =
 * f(deadline proximity, priority). Deadlines dominate — bands are spaced by 10
 * so priority (0..3) only ever breaks ties *within* a band, never across one.
 * Pure + `now`-injected so the Daily Digest (2.8) and the board reuse one truth.
 */
const DAY = 86_400_000;

/** Priority → weight. Handles the triage vocabulary (P0..P3) and named levels. */
export function priorityWeight(priority: string | null | undefined): number {
  if (!priority) return 0.5; // unknown — just above "low"
  const p = priority.trim().toLowerCase();
  if (["p0", "urgent", "critical", "highest"].includes(p)) return 3;
  if (["p1", "high"].includes(p)) return 2;
  if (["p2", "medium", "normal", "med"].includes(p)) return 1;
  if (["p3", "low", "lowest"].includes(p)) return 0;
  return 0.5;
}

/** Deadline proximity → a banded score (bands spaced by 10; deadlines dominate). */
export function deadlineBand(deadline: number | null, now: number): number {
  if (deadline == null) return 0;
  const days = (deadline - now) / DAY;
  if (days < 0) return 50; // overdue
  if (days <= 1) return 40;
  if (days <= 3) return 30;
  if (days <= 7) return 20;
  if (days <= 14) return 10;
  return 5; // has a deadline, but far off
}

export function urgencyScore(task: Pick<Task, "deadline" | "priority">, now: number): number {
  return deadlineBand(task.deadline, now) + priorityWeight(task.priority);
}

export function urgencyTier(task: Pick<Task, "deadline">, now: number): UrgencyTier {
  if (task.deadline == null) return "none";
  const days = (task.deadline - now) / DAY;
  if (days < 0) return "overdue";
  if (days <= 3) return "due_soon";
  return "upcoming";
}

/** Annotate a task with its computed urgency + tier (request-time, not persisted). */
export function withUrgency<T extends Pick<Task, "deadline" | "priority">>(
  task: T,
  now: number,
): T & { urgency: number; urgencyTier: UrgencyTier } {
  return { ...task, urgency: urgencyScore(task, now), urgencyTier: urgencyTier(task, now) };
}

/** Most-urgent first; newest-first as a stable tiebreaker. */
export function sortByUrgency<T extends Pick<Task, "deadline" | "priority" | "createdAt">>(
  tasks: T[],
  now: number,
): T[] {
  return [...tasks].sort((a, b) => {
    const d = urgencyScore(b, now) - urgencyScore(a, now);
    if (d !== 0) return d;
    return b.createdAt - a.createdAt;
  });
}
