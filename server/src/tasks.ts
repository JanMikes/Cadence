import type { Task, TaskDetail, UpdateTaskInput } from "@cadence/shared";
import { eq, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import type { Db } from "./db/client";
import { tasks } from "./db/schema";
import { getProjectById } from "./projects";
import { paths } from "./store/paths";
import { readTask, reindexTask, writeTask } from "./store/store";
import type { TaskFrontmatter } from "./store/types";

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

/** Task + its markdown-only fields (labels), for the detail view. */
export function getTaskDetail(db: Db, id: string): TaskDetail | null {
  const task = getTask(db, id);
  if (!task) return null;
  let labels: string[] = [];
  try {
    labels = readTask(id).data.labels ?? [];
  } catch {
    /* markdown missing — index-only row */
  }
  return { ...task, labels };
}

/**
 * Patch a task: merge the change into its task.md frontmatter (the source of
 * truth), reindex, and return the updated detail. Returns null if it's missing.
 * Used by the board (status drag) and the detail editor.
 */
export function updateTask(db: Db, id: string, patch: UpdateTaskInput): TaskDetail | null {
  if (!existsSync(paths.taskFile(id))) return null;
  const { data, body } = readTask(id);

  const next: TaskFrontmatter = { ...data, id };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.estimate !== undefined) next.estimate = patch.estimate;
  if (patch.labels !== undefined) next.labels = patch.labels;
  if (patch.deliveryMode !== undefined) next.deliveryMode = patch.deliveryMode;
  if (patch.project !== undefined) next.project = patch.project; // slug; reindex → projectId
  if (patch.fleet !== undefined) next.fleet = patch.fleet;
  if (patch.deadline !== undefined) {
    next.deadline = patch.deadline == null ? null : new Date(patch.deadline).toISOString();
  }
  const nextBody = patch.body !== undefined ? patch.body : body;

  writeTask(next, nextBody);
  reindexTask(db, id);
  return getTaskDetail(db, id);
}

/**
 * Resolve the working directory a Claude session for this task should run in:
 * the assigned project's rootPath, else CADENCE_DEFAULT_CWD, else the process cwd.
 * (Used by the spawn pipeline in 1.4.)
 */
export function resolveTaskCwd(db: Db, taskId: string): string {
  const task = getTask(db, taskId);
  if (task?.projectId) {
    const project = getProjectById(db, task.projectId);
    if (project?.rootPath) return project.rootPath;
  }
  return process.env.CADENCE_DEFAULT_CWD ?? process.cwd();
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
