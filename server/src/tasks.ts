import type { Task } from "@cadence/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { tasks } from "./db/schema";
import { reindexTask, writeTask } from "./store/store";

// Newest-first, with the implicit rowid as a deterministic tiebreaker so tasks
// captured within the same millisecond keep a stable order (no UI jitter).
const NEWEST_FIRST = sql`${tasks.createdAt} desc, rowid desc`;

export interface CreateTaskArgs {
  title: string;
  body?: string;
}

/**
 * Capture a new task: write its task.md (the source of truth) and reindex it
 * synchronously so the row exists immediately (the watcher is only a backstop
 * for out-of-band edits). New tasks land in the Inbox.
 */
export function createTask(db: Db, args: CreateTaskArgs): Task {
  const id = crypto.randomUUID();
  writeTask({ id, title: args.title, status: "inbox" }, args.body ?? "");
  reindexTask(db, id);
  const task = getTask(db, id);
  if (!task) throw new Error(`createTask: task ${id} missing after reindex`);
  return task;
}

export function listTasks(db: Db, opts: { status?: string } = {}): Task[] {
  const base = db.select().from(tasks);
  const rows = opts.status
    ? base.where(eq(tasks.status, opts.status)).orderBy(NEWEST_FIRST).all()
    : base.orderBy(NEWEST_FIRST).all();
  return rows.map(toTask);
}

export function getTask(db: Db, id: string): Task | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? toTask(row) : null;
}

function toTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    projectId: row.projectId,
    fleetId: row.fleetId,
    deadline: row.deadline,
    estimate: row.estimate,
    deliveryMode: row.deliveryMode,
    parentTaskId: row.parentTaskId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
