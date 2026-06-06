import type { TaskEvent } from "@cadence/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { events } from "./db/schema";

export interface RecordEventInput {
  taskId?: string | null;
  sessionId?: string | null;
  type: string;
  /** Arbitrary JSON detail (serialized for storage). */
  payload?: unknown;
}

/** Append an event to the timeline (the `events` table). Fire-and-forget. */
export function recordEvent(db: Db, input: RecordEventInput): void {
  db.insert(events)
    .values({
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      type: input.type,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    })
    .run();
}

/** A task's timeline, oldest-first (createdAt, then id for same-ms stability). */
export function listTaskEvents(db: Db, taskId: string): TaskEvent[] {
  return db
    .select()
    .from(events)
    .where(eq(events.taskId, taskId))
    .orderBy(asc(events.createdAt), asc(events.id))
    .all()
    .map(toTaskEvent);
}

function toTaskEvent(row: typeof events.$inferSelect): TaskEvent {
  let payload: unknown = null;
  if (row.payload != null) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload; // tolerate a non-JSON payload rather than throw
    }
  }
  return {
    id: row.id,
    taskId: row.taskId,
    sessionId: row.sessionId,
    type: row.type,
    payload,
    createdAt: row.createdAt,
  };
}
