import { existsSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { fleets, projects, tasks } from "../db/schema";
import { paths } from "./paths";
import { listTaskIds, reindexFleet, reindexProject, reindexTask } from "./store";

export type ChangeKind = "task" | "project" | "fleet" | "ignored";

/** Map a path relative to ~/.cadence to the entity it represents. */
export function classifyPath(relPath: string): { kind: ChangeKind; key?: string } {
  const norm = relPath.split(sep).join("/");
  let m = norm.match(/^tasks\/([^/]+)\/task\.md$/);
  if (m?.[1]) return { kind: "task", key: m[1] };
  m = norm.match(/^projects\/([^/]+)\.md$/);
  if (m?.[1]) return { kind: "project", key: m[1] };
  m = norm.match(/^fleets\/([^/]+)\.md$/);
  if (m?.[1]) return { kind: "fleet", key: m[1] };
  return { kind: "ignored" };
}

/**
 * Apply one change: reindex the entity if its markdown still exists, else remove
 * its index row (the DB derives from the markdown source of truth). FTS stays in
 * sync via the task triggers. Synchronous + deterministic, so it's unit-testable
 * without depending on fs.watch timing.
 */
export function dispatchChange(db: Db, relPath: string): ChangeKind {
  const { kind, key } = classifyPath(relPath);
  if (!key) return "ignored";

  switch (kind) {
    case "task":
      if (existsSync(paths.taskFile(key))) reindexTask(db, key);
      else db.delete(tasks).where(eq(tasks.id, key)).run();
      return "task";
    case "project":
      if (existsSync(paths.projectFile(key))) reindexProject(db, key);
      else db.delete(projects).where(eq(projects.slug, key)).run();
      return "project";
    case "fleet":
      if (existsSync(paths.fleetFile(key))) reindexFleet(db, key);
      else db.delete(fleets).where(eq(fleets.slug, key)).run();
      return "fleet";
    default:
      return "ignored";
  }
}

export interface WatcherHandle {
  close: () => void;
  /** Force an immediate scan (also runs once at startup). Returns changes applied. */
  scan: () => number;
}

export interface WatcherOptions {
  /** Poll interval in ms (default 700). */
  intervalMs?: number;
  /** Called after a change is applied (handy for tests / logging). */
  onChange?: (kind: ChangeKind, relPath: string) => void;
}

/**
 * Watch ~/.cadence and reindex changed task/project/fleet markdown into SQLite
 * (+FTS). Returns a handle whose close() stops the watch.
 *
 * Implemented by polling file mtimes rather than fs.watch: Bun's fs.watch does
 * not reliably deliver events for nested directories created after the watch
 * starts (each task lives in its own `tasks/<id>/` dir) — under load it can drop
 * them entirely. Polling is deterministic and cross-platform, and the file set
 * (a local single user's tasks) is small, so the cost is negligible. The first
 * scan doubles as a startup reconcile (index ⇽ markdown source of truth).
 */
export function startWatcher(db: Db, opts: WatcherOptions = {}): WatcherHandle {
  const intervalMs = opts.intervalMs ?? 700;
  const seen = new Map<string, number>(); // relPath -> mtimeMs

  const snapshot = (): Map<string, number> => {
    const files = new Map<string, number>();
    const add = (rel: string, abs: string) => {
      try {
        files.set(rel, statSync(abs).mtimeMs);
      } catch {
        /* vanished mid-scan — treat as absent */
      }
    };
    for (const id of listTaskIds()) add(`tasks/${id}/task.md`, paths.taskFile(id));
    for (const f of listMd(paths.projectsDir())) add(`projects/${f}`, join(paths.projectsDir(), f));
    for (const f of listMd(paths.fleetsDir())) add(`fleets/${f}`, join(paths.fleetsDir(), f));
    return files;
  };

  const apply = (rel: string) => {
    try {
      // NB: call dispatchChange first — `onChange?.(dispatchChange(...), rel)`
      // would short-circuit and skip the reindex when onChange is undefined.
      const kind = dispatchChange(db, rel);
      opts.onChange?.(kind, rel);
    } catch (err) {
      console.error(`[cadence] reindex failed for ${rel}:`, err);
    }
  };

  const scan = (): number => {
    const now = snapshot();
    let changes = 0;
    for (const [rel, mtime] of now) {
      if (seen.get(rel) !== mtime) {
        seen.set(rel, mtime);
        apply(rel);
        changes++;
      }
    }
    for (const rel of [...seen.keys()]) {
      if (!now.has(rel)) {
        seen.delete(rel);
        apply(rel); // gone -> dispatchChange removes the index row
        changes++;
      }
    }
    return changes;
  };

  scan(); // startup reconcile
  const timer = setInterval(scan, intervalMs);
  return { close: () => clearInterval(timer), scan };
}

function listMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
