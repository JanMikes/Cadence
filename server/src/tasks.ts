import type { Task, TaskDetail, UpdateTaskInput } from "@cadence/shared";
import { eq, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import type { Db } from "./db/client";
import { tasks } from "./db/schema";
import { recordEvent } from "./events";
import { sortByUrgency, withUrgency } from "./prioritize";
import { getProjectById } from "./projects";
import { taskCostUsd } from "./sessions";
import { paths } from "./store/paths";
import { readSettings, readTask, reindexTask, writeTask } from "./store/store";
import type { TaskFrontmatter } from "./store/types";

// Newest-first, with the implicit rowid as a deterministic tiebreaker so tasks
// captured within the same millisecond keep a stable order (no UI jitter).
const NEWEST_FIRST = sql`${tasks.createdAt} desc, rowid desc`;

export interface CreateTaskArgs {
  /** Optional — when omitted, a provisional title is derived from the description
   *  (first line, trimmed) and the refinement pipeline names the task properly. */
  title?: string;
  body?: string;
  /** Capture-time review classification (6.5.a). */
  taskType?: string;
  reviewDirection?: string;
  reviewRef?: string;
  /** Project slug proposed at capture (e.g. matched from the PR/MR repo). */
  project?: string;
}

/** Derive a provisional title from a description: its first line, squashed and
 *  capped at 60 chars (cut at a word boundary). Used for description-only capture. */
export function deriveTitle(body: string): string {
  const line = (body.split("\n").find((l) => l.trim()) ?? "").trim().replace(/\s+/g, " ");
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const word = cut.slice(0, cut.lastIndexOf(" "));
  return `${word.length >= 20 ? word : cut}…`;
}

/**
 * Capture a new task: write its task.md (the source of truth) and reindex it
 * synchronously so the row exists immediately (the watcher is only a backstop
 * for out-of-band edits). New tasks land in the Inbox. Description-first: with
 * no explicit title, a provisional one is derived and flagged `titleGenerated`
 * so the triage agent knows to name the task.
 */
export function createTask(db: Db, args: CreateTaskArgs): Task {
  const explicit = args.title?.trim();
  const title = explicit || deriveTitle(args.body ?? "");
  if (!title) throw new Error("createTask: a title or description is required");
  const id = crypto.randomUUID();
  writeTask(
    {
      id,
      title,
      status: "inbox",
      ...(explicit ? {} : { titleGenerated: true }),
      // Capture-time review classification (6.5.a) — proposed by the capture chips.
      ...(args.taskType === "code_review"
        ? {
            taskType: "code_review",
            reviewDirection: args.reviewDirection ?? "perform",
            ...(args.reviewRef ? { reviewRef: args.reviewRef } : {}),
          }
        : {}),
      ...(args.project ? { project: args.project } : {}),
    },
    args.body ?? "",
  );
  reindexTask(db, id);
  const task = getTask(db, id);
  if (!task) throw new Error(`createTask: task ${id} missing after reindex`);
  recordEvent(db, { taskId: id, type: "status_change", payload: { from: null, to: task.status } });
  return task;
}

export function listTasks(db: Db, opts: { status?: string; sort?: "urgency" } = {}): Task[] {
  const now = Date.now();
  const base = db.select().from(tasks);
  const rows = opts.status
    ? base.where(eq(tasks.status, opts.status)).orderBy(NEWEST_FIRST).all()
    : base.orderBy(NEWEST_FIRST).all();
  const out = rows.map((row) => withUrgency(toTask(row), now));
  return opts.sort === "urgency" ? sortByUrgency(out, now) : out;
}

export function getTask(db: Db, id: string): Task | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? toTask(row) : null;
}

/**
 * Resolve a task's effective permission mode (§9.1): the task's own override,
 * else its project default, else the global default, else "auto".
 */
export function resolvePermissionMode(db: Db, taskId: string): string {
  const task = getTask(db, taskId);
  if (task?.permissionMode) return task.permissionMode;
  if (task?.projectId) {
    const project = getProjectById(db, task.projectId);
    if (project?.defaultPermissionMode) return project.defaultPermissionMode;
  }
  return readSettings().global.defaultPermissionMode || "auto";
}

/**
 * Resolve a task's effective delivery mode (§8): the task's own override, else
 * its project default, else the global default, else "branch_summary".
 */
export function resolveDeliveryMode(db: Db, taskId: string): string {
  const task = getTask(db, taskId);
  if (task?.deliveryMode) return task.deliveryMode;
  if (task?.projectId) {
    const project = getProjectById(db, task.projectId);
    if (project?.defaultDeliveryMode) return project.defaultDeliveryMode;
  }
  return readSettings().global.defaultDeliveryMode || "branch_summary";
}

/** Task + its markdown-only fields (labels) + resolved permission, for the detail view. */
export function getTaskDetail(db: Db, id: string): TaskDetail | null {
  const task = getTask(db, id);
  if (!task) return null;
  let labels: string[] = [];
  let titleGenerated = false;
  try {
    const { data } = readTask(id);
    labels = data.labels ?? [];
    titleGenerated = data.titleGenerated ?? false;
  } catch {
    /* markdown missing — index-only row */
  }
  return {
    ...withUrgency(task, Date.now()),
    labels,
    titleGenerated,
    resolvedPermissionMode: resolvePermissionMode(db, id),
    costUsd: taskCostUsd(db, id),
  };
}

/**
 * Patch a task: merge the change into its task.md frontmatter (the source of
 * truth), reindex, and return the updated detail. Returns null if it's missing.
 * Used by the board (status drag) and the detail editor.
 */
export function updateTask(db: Db, id: string, patch: UpdateTaskInput): TaskDetail | null {
  if (!existsSync(paths.taskFile(id))) return null;
  const before = getTask(db, id);
  const { data, body } = readTask(id);

  const next: TaskFrontmatter = { ...data, id };
  if (patch.title !== undefined) {
    next.title = patch.title;
    // A real title now exists (user-edited or agent-named) — drop the placeholder flag.
    delete next.titleGenerated;
  }
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.estimate !== undefined) next.estimate = patch.estimate;
  if (patch.labels !== undefined) next.labels = patch.labels;
  if (patch.deliveryMode !== undefined) next.deliveryMode = patch.deliveryMode;
  if (patch.taskType !== undefined) next.taskType = patch.taskType;
  if (patch.reviewDirection !== undefined) next.reviewDirection = patch.reviewDirection;
  if (patch.reviewRef !== undefined) next.reviewRef = patch.reviewRef;
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
  if (patch.project !== undefined) next.project = patch.project; // slug; reindex → projectId
  if (patch.fleet !== undefined) next.fleet = patch.fleet;
  if (patch.parentTask !== undefined) next.parentTask = patch.parentTask;
  if (patch.deadline !== undefined) {
    next.deadline = patch.deadline == null ? null : new Date(patch.deadline).toISOString();
  }
  const nextBody = patch.body !== undefined ? patch.body : body;

  writeTask(next, nextBody);
  reindexTask(db, id);
  const detail = getTaskDetail(db, id);
  if (detail && before && detail.status !== before.status) {
    recordEvent(db, {
      taskId: id,
      type: "status_change",
      payload: { from: before.status, to: detail.status },
    });
  }
  return detail;
}

/** Persist the PR/MR url an auto_pr delivery opened (server-managed — not part of the PATCH API). */
export function setTaskPrUrl(db: Db, id: string, prUrl: string): TaskDetail | null {
  if (!existsSync(paths.taskFile(id))) return null;
  const { data, body } = readTask(id);
  writeTask({ ...data, id, prUrl }, body);
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
    prUrl: row.prUrl,
    taskType: row.taskType,
    reviewDirection: row.reviewDirection,
    reviewRef: row.reviewRef,
    permissionMode: row.permissionMode,
    parentTaskId: row.parentTaskId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
