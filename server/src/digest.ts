import type { CommitDigestInput, DailyDigest, DigestPick, Task } from "@cadence/shared";
import type { Db } from "./db/client";
import { sortByUrgency, urgencyTier } from "./prioritize";
import { readDigest, writeDigest } from "./store/store";
import { getTask, listTasks } from "./tasks";

/** How many tasks the morning shortlist proposes by default. */
const SHORTLIST_SIZE = 7;

/** Statuses that don't belong on a "today" plan (already finished / dropped). */
const CLOSED = new Set(["done", "cancelled"]);

/** Server-local date (YYYY-MM-DD) for `now` — the digest's natural key. */
export function todayString(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PRIORITY_LABEL: Record<string, string> = {
  p0: "P0",
  p1: "P1",
  p2: "P2",
  p3: "P3",
};

/** A one-line reason a task earned its place on the shortlist (deadline-first). */
export function pickRationale(task: Task, now: number): string {
  const parts: string[] = [];
  const tier = urgencyTier(task, now);
  if (task.deadline != null) {
    const days = Math.round((task.deadline - now) / 86_400_000);
    if (tier === "overdue") parts.push(`Overdue by ${Math.abs(days)}d`);
    else if (days <= 0) parts.push("Due today");
    else if (days === 1) parts.push("Due tomorrow");
    else parts.push(`Due in ${days}d`);
  }
  if (task.priority) parts.push(PRIORITY_LABEL[task.priority.toLowerCase()] ?? task.priority);
  if (parts.length === 0) {
    if (task.status === "ready") parts.push("Ready to start");
    else if (task.status === "needs_feedback") parts.push("Needs your input");
    else if (task.status === "implementing") parts.push("In progress");
    else parts.push("On your plate");
  }
  return parts.join(" · ");
}

function toPick(task: Task, order: number, now: number): DigestPick {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    rationale: pickRationale(task, now),
    order,
    urgencyTier: urgencyTier(task, now),
  };
}

/** Propose today's plan: open tasks, deadline-first, top N — status "planning". */
export function proposePlan(db: Db, date: string, now: number): DailyDigest {
  const open = listTasks(db).filter((t) => !CLOSED.has(t.status));
  const ranked = sortByUrgency(open, now).slice(0, SHORTLIST_SIZE);
  return {
    date,
    status: "planning",
    picks: ranked.map((t, i) => toPick(t, i, now)),
    goal: null,
    constraints: null,
    committedAt: null,
  };
}

/**
 * The digest for a date: the committed plan if one exists on disk, else a fresh
 * proposal computed from the current open tasks.
 */
export function getDigest(db: Db, now: number, date = todayString(now)): DailyDigest {
  return readDigest(date) ?? proposePlan(db, date, now);
}

/** Commit an (ordered) set of task ids as today's plan → digests/<date>.md. */
export function commitDigest(db: Db, input: CommitDigestInput, now: number): DailyDigest {
  const date = input.date ?? todayString(now);
  const picks: DigestPick[] = [];
  input.picks.forEach((taskId) => {
    const task = getTask(db, taskId);
    if (task) picks.push(toPick(task, picks.length, now));
  });
  const digest: DailyDigest = {
    date,
    status: "committed",
    picks,
    goal: input.goal?.trim() ? input.goal.trim() : null,
    constraints: input.constraints?.trim() ? input.constraints.trim() : null,
    committedAt: now,
  };
  writeDigest(digest);
  return digest;
}
