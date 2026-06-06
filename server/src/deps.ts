import type { Task } from "@cadence/shared";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { taskDeps, tasks } from "./db/schema";
import { readTask, reindexTask, writeTask } from "./store/store";
import type { TaskFrontmatter } from "./store/types";
import { getTask } from "./tasks";

export interface DepError {
  ok: false;
  reason: string;
}
export type DepResult = { ok: true } | DepError;

/** Direct blockers (this task is blockedBy …) from the index edges. */
function blockerIds(db: Db, taskId: string): string[] {
  return db
    .select({ id: taskDeps.blockerTaskId })
    .from(taskDeps)
    .where(eq(taskDeps.blockedTaskId, taskId))
    .all()
    .map((r) => r.id);
}

/** Direct dependents (tasks this one blocks) from the index edges. */
function blockedIds(db: Db, taskId: string): string[] {
  return db
    .select({ id: taskDeps.blockedTaskId })
    .from(taskDeps)
    .where(eq(taskDeps.blockerTaskId, taskId))
    .all()
    .map((r) => r.id);
}

/**
 * Would adding "blocker blocks task" create a cycle? It does iff `task` can
 * already reach `blocker` along blocks-edges (task → … → blocker), since the new
 * edge points blocker → task. BFS over the blocks graph from `task`.
 */
export function wouldCycle(db: Db, taskId: string, blockerId: string): boolean {
  if (taskId === blockerId) return true;
  const seen = new Set<string>();
  const queue = [taskId];
  while (queue.length) {
    const cur = queue.shift() as string;
    if (cur === blockerId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...blockedIds(db, cur));
  }
  return false;
}

/** Add a dependency: `blockerId` must finish before `taskId`. */
export function addDependency(db: Db, taskId: string, blockerId: string): DepResult {
  if (taskId === blockerId) return { ok: false, reason: "a task cannot block itself" };
  if (!getTask(db, taskId) || !getTask(db, blockerId)) return { ok: false, reason: "task not found" };
  if (wouldCycle(db, taskId, blockerId)) return { ok: false, reason: "that would create a dependency cycle" };

  const { data, body } = readTask(taskId);
  const blockedBy = new Set(data.blockedBy ?? []);
  blockedBy.add(blockerId);
  writeTask({ ...data, id: taskId, blockedBy: [...blockedBy] } as TaskFrontmatter, body);
  reindexTask(db, taskId);
  return { ok: true };
}

/** Remove a dependency edge. */
export function removeDependency(db: Db, taskId: string, blockerId: string): DepResult {
  if (!getTask(db, taskId)) return { ok: false, reason: "task not found" };
  const { data, body } = readTask(taskId);
  const blockedBy = (data.blockedBy ?? []).filter((id) => id !== blockerId);
  writeTask({ ...data, id: taskId, blockedBy } as TaskFrontmatter, body);
  reindexTask(db, taskId);
  return { ok: true };
}

export interface TaskDepsView {
  blockedBy: Task[]; // must finish before this task
  blocks: Task[]; // this task must finish before these
}

export function getDeps(db: Db, taskId: string): TaskDepsView {
  const resolve = (ids: string[]) => ids.map((id) => getTask(db, id)).filter((t): t is Task => t !== null);
  return { blockedBy: resolve(blockerIds(db, taskId)), blocks: resolve(blockedIds(db, taskId)) };
}

/** Child tasks (parentTaskId = this task), newest-first. */
export function getSubtasks(db: Db, taskId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, taskId))
    .all()
    .map((row) => getTask(db, row.id))
    .filter((t): t is Task => t !== null);
}

/** A task is dependency-blocked while any of its blockers isn't done. */
export function isBlocked(db: Db, taskId: string): boolean {
  return blockerIds(db, taskId).some((id) => getTask(db, id)?.status !== "done");
}
