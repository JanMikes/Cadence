import { existsSync, rmSync } from "node:fs";
import {
  describeSchedule,
  type CreateRecurringInput,
  type NotifyPayload,
  type RecurringCadence,
  type RecurringTask,
  type Task,
  type UpdateRecurringInput,
} from "@cadence/shared";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "./db/client";
import { recurringTasks } from "./db/schema";
import { paths } from "./store/paths";
import { appendContext, readRecurring, reindexRecurring, writeRecurring } from "./store/store";
import type { RecurringFrontmatter } from "./store/types";
import { createTask, deriveTitle } from "./tasks";
import type { WsHub } from "./ws";

/**
 * Recurring tasks (templates + schedule). The markdown under
 * `~/.cadence/recurring/` is the source of truth (one file per template; the
 * body is the task-description template); the SQLite row indexes the schedule
 * plus the derived `nextRunAt`, so the scheduler's due-check is a plain indexed
 * comparison. At each trigger a REAL task is created via the same `createTask`
 * path as capture, so triage/refinement treat it like anything Jan typed in.
 */

export function createRecurring(db: Db, input: CreateRecurringInput): RecurringTask {
  const explicit = input.title?.trim();
  const title = explicit || deriveTitle(input.body ?? "");
  if (!title) throw new Error("createRecurring: a title or description is required");
  const id = crypto.randomUUID();
  writeRecurring(
    {
      id,
      title,
      cadence: input.cadence,
      ...(input.cadence === "weekly" ? { dayOfWeek: input.dayOfWeek ?? 1 } : {}),
      ...(input.cadence === "monthly" ? { dayOfMonth: input.dayOfMonth ?? 1 } : {}),
      time: input.time,
      ...(input.project ? { project: input.project } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      paused: false,
      createdAt: new Date().toISOString(),
    },
    input.body ?? "",
  );
  reindexRecurring(db, id);
  const created = getRecurring(db, id);
  if (!created) throw new Error(`createRecurring: template ${id} missing after reindex`);
  return created;
}

export function getRecurring(db: Db, id: string): RecurringTask | null {
  const row = db.select().from(recurringTasks).where(eq(recurringTasks.id, id)).get();
  return row ? toRecurring(row) : null;
}

/** All templates: active first (soonest next run on top), paused last. */
export function listRecurring(db: Db): RecurringTask[] {
  return db
    .select()
    .from(recurringTasks)
    .orderBy(asc(recurringTasks.paused), asc(recurringTasks.nextRunAt), asc(recurringTasks.createdAt))
    .all()
    .map(toRecurring);
}

/** Patch a template: merge into its markdown frontmatter (source of truth),
 *  reindex (recomputes nextRunAt), return the updated DTO. Null if missing. */
export function updateRecurring(db: Db, id: string, patch: UpdateRecurringInput): RecurringTask | null {
  if (!existsSync(paths.recurringFile(id))) return null;
  const { data, body } = readRecurring(id);

  const next: RecurringFrontmatter = { ...data, id };
  if (patch.title !== undefined && patch.title.trim()) next.title = patch.title.trim();
  if (patch.cadence !== undefined) next.cadence = patch.cadence;
  if (patch.dayOfWeek !== undefined) next.dayOfWeek = patch.dayOfWeek;
  if (patch.dayOfMonth !== undefined) next.dayOfMonth = patch.dayOfMonth;
  if (patch.time !== undefined) next.time = patch.time;
  if (patch.project !== undefined) next.project = patch.project;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.paused !== undefined) next.paused = patch.paused;
  // Day fields only make sense for their cadence — drop strays so an edited
  // template never carries a stale dayOfMonth into a weekly schedule.
  if (next.cadence !== "weekly") delete next.dayOfWeek;
  if (next.cadence !== "monthly") delete next.dayOfMonth;
  const nextBody = patch.body !== undefined ? patch.body : body;

  writeRecurring(next, nextBody);
  reindexRecurring(db, id);
  return getRecurring(db, id);
}

/** Delete a template (markdown + index row). The tasks it created stay. */
export function deleteRecurring(db: Db, id: string): boolean {
  const file = paths.recurringFile(id);
  if (!existsSync(file)) return false;
  rmSync(file);
  db.delete(recurringTasks).where(eq(recurringTasks.id, id)).run();
  return true;
}

/**
 * Fire one template NOW: create a real task from it (inbox, same as capture),
 * stamp the trigger into the markdown (lastTriggeredAt anchors the next
 * occurrence; lastTaskId links the card to its newest task), and reindex.
 * Used by every scheduler tick and by the explicit "Run now" button.
 */
export function triggerRecurring(
  db: Db,
  id: string,
  now: number = Date.now(),
): { task: Task; recurring: RecurringTask } | null {
  if (!existsSync(paths.recurringFile(id))) return null;
  const { data, body } = readRecurring(id);

  const task = createTask(db, {
    title: data.title,
    body,
    ...(data.project ? { project: data.project } : {}),
    ...(data.priority ? { priority: data.priority } : {}),
  });
  // Attribution in the task's context channel: where this task came from.
  appendContext(
    task.id,
    `Created automatically by the recurring task "${data.title}" (${describeSchedule({
      cadence: (data.cadence ?? "daily") as RecurringCadence,
      dayOfWeek: data.dayOfWeek,
      dayOfMonth: data.dayOfMonth,
      time: data.time ?? "09:00",
    })}).`,
    new Date(now),
  );

  writeRecurring(
    { ...data, id, lastTriggeredAt: new Date(now).toISOString(), lastTaskId: task.id },
    body,
  );
  reindexRecurring(db, id);
  const recurring = getRecurring(db, id);
  if (!recurring) return null;
  return { task, recurring };
}

export interface RecurringTickResult {
  created: Array<{ recurring: RecurringTask; task: Task }>;
}

/**
 * One scheduler pass: fire every active template whose nextRunAt has arrived.
 * Pure-ish + now-injected (unit-testable). Occurrences missed while the app was
 * off collapse into a single catch-up run — triggering re-anchors the schedule
 * at `now`, so the next occurrence is back in the future.
 */
export function runRecurringTick(db: Db, now: number = Date.now()): RecurringTickResult {
  const due = db
    .select({ id: recurringTasks.id })
    .from(recurringTasks)
    .where(and(eq(recurringTasks.paused, false), lte(recurringTasks.nextRunAt, now)))
    .all();

  const created: RecurringTickResult["created"] = [];
  for (const { id } of due) {
    try {
      const fired = triggerRecurring(db, id, now);
      if (fired) created.push({ recurring: fired.recurring, task: fired.task });
    } catch (err) {
      // One broken template (hand-edited markdown, deleted project dir, …) must
      // never stop the others from firing.
      console.error(`[cadence] recurring trigger failed for ${id}:`, err);
    }
  }
  return { created };
}

export interface RecurringSchedulerHandle {
  close(): void;
}

/**
 * Start the background scheduler: an immediate catch-up pass at boot (anything
 * that came due while the app was off fires once now), then a tick every
 * `intervalMs` (default 30 s; CADENCE_RECURRING_MS overrides). Each created
 * task is announced like a capture (`task:created` + a notification) plus a
 * `recurring:triggered` event so the Recurring view refreshes its next-run.
 */
export function startRecurringScheduler(
  db: Db,
  hub: WsHub,
  opts: { intervalMs?: number; onTaskCreated?: (taskId: string) => void } = {},
): RecurringSchedulerHandle {
  const intervalMs = opts.intervalMs ?? Number(process.env.CADENCE_RECURRING_MS ?? 30_000);
  if (!intervalMs || intervalMs <= 0) return { close() {} };

  const tick = () => {
    try {
      const { created } = runRecurringTick(db, Date.now());
      for (const { recurring, task } of created) {
        hub.broadcast({ type: "event", name: "task:created", payload: task.id });
        hub.broadcast({
          type: "event",
          name: "recurring:triggered",
          payload: { recurringId: recurring.id, taskId: task.id },
        });
        hub.broadcast({
          type: "event",
          name: "notify",
          payload: {
            kind: "info",
            title: "Recurring task created",
            message: `“${task.title}” — ${describeSchedule(recurring)}`,
            taskId: task.id,
          } satisfies NotifyPayload,
        });
        opts.onTaskCreated?.(task.id); // hands the task to triage, like capture
      }
    } catch (err) {
      console.error("[cadence] recurring tick failed:", err);
    }
  };

  tick(); // boot catch-up
  const timer = setInterval(tick, intervalMs);
  return {
    close() {
      clearInterval(timer);
    },
  };
}

function toRecurring(row: typeof recurringTasks.$inferSelect): RecurringTask {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    cadence: row.cadence as RecurringCadence,
    dayOfWeek: row.dayOfWeek,
    dayOfMonth: row.dayOfMonth,
    time: row.time,
    projectId: row.projectId,
    priority: row.priority,
    paused: row.paused,
    lastTriggeredAt: row.lastTriggeredAt,
    lastTaskId: row.lastTaskId,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
