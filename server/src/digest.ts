import type {
  CommitDigestInput,
  DailyDigest,
  DigestPick,
  DigestRecap,
  Task,
} from "@cadence/shared";
import { existsSync, readdirSync } from "node:fs";
import type { Db } from "./db/client";
import { sortByUrgency, urgencyTier } from "./prioritize";
import { paths } from "./store/paths";
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

const DAY = 86_400_000;

/**
 * Live goal progress for a digest: how many picks are now done. Recapped days
 * use their frozen recap counts; otherwise we count current task statuses.
 */
export function computeProgress(db: Db, digest: DailyDigest): { done: number; total: number } {
  if (digest.recap) return { done: digest.recap.done, total: digest.recap.total };
  const total = digest.picks.length;
  const done = digest.picks.filter((p) => getTask(db, p.taskId)?.status === "done").length;
  return { done, total };
}

/**
 * The streak: consecutive days (ending today, or yesterday if today isn't
 * recapped yet) whose plan was *met*. Reads the recorded recap of each
 * digests/<date>.md, so it reflects each day's outcome, not current state.
 */
export function computeStreak(now: number): number {
  const dir = paths.digestsDir();
  if (!existsSync(dir)) return 0;
  const met = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const date = f.slice(0, -3);
    const d = readDigest(date);
    if (d?.status === "recapped" && d.recap?.met) met.add(date);
  }
  // Don't penalize an in-progress today: if today isn't met yet, start at yesterday.
  let cursor = met.has(todayString(now)) ? now : now - DAY;
  let streak = 0;
  while (met.has(todayString(cursor))) {
    streak++;
    cursor -= DAY;
  }
  return streak;
}

/**
 * The digest for a date: the committed/recapped plan if one exists on disk,
 * else a fresh proposal — annotated with live progress + the current streak.
 */
export function getDigest(db: Db, now: number, date = todayString(now)): DailyDigest {
  const base = readDigest(date) ?? proposePlan(db, date, now);
  return { ...base, progress: computeProgress(db, base), streak: computeStreak(now) };
}

/** A tasteful, positive completion note (never guilt) from what actually shipped. */
export function generateNote(shipped: string[], done: number, total: number, met: boolean): string {
  if (total === 0) {
    return "No plan was set — capture a few tasks tomorrow and Cadence will line them up.";
  }
  if (met) {
    const head = total === 1 ? "Shipped your one focus" : `Cleared all ${total}`;
    const lead = shipped[0] ? ` — ${shipped[0]}` : "";
    const more = shipped.length > 1 ? ` and ${shipped.length - 1} more` : "";
    return `${head}${lead}${more}. Strong day. 🔥`;
  }
  if (done === 0) {
    return `Fresh start tomorrow — your ${total} ${total === 1 ? "task is" : "tasks are"} already queued up.`;
  }
  const lead = shipped[0] ? ` — ${shipped[0]}` : "";
  const more = shipped.length > 1 ? ` +${shipped.length - 1} more` : "";
  return `Shipped ${done} of ${total}${lead}${more}. Solid progress; the rest roll into tomorrow.`;
}

/**
 * Close out the day: tally shipped vs rolled-over from current task statuses,
 * write a positive recap into digests/<date>.md (status → "recapped"), and
 * return it. Incomplete picks are still open, so tomorrow's proposal re-surfaces
 * them automatically (the "seed tomorrow" behaviour).
 */
export function recapDigest(db: Db, now: number, date = todayString(now)): DailyDigest {
  const base = readDigest(date) ?? proposePlan(db, date, now);
  const shipped: string[] = [];
  const rolledOver: string[] = [];
  for (const p of base.picks) {
    const status = getTask(db, p.taskId)?.status;
    if (status === "done") shipped.push(p.title);
    else rolledOver.push(p.taskId);
  }
  const total = base.picks.length;
  const done = shipped.length;
  const met = total > 0 && done === total;
  const recap: DigestRecap = {
    done,
    total,
    met,
    shipped,
    rolledOver,
    note: generateNote(shipped, done, total, met),
    recappedAt: now,
  };
  const digest: DailyDigest = { ...base, status: "recapped", recap };
  delete digest.progress;
  delete digest.streak;
  writeDigest(digest);
  return { ...digest, progress: { done, total }, streak: computeStreak(now) };
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
