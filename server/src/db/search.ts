import type { SearchHit } from "@cadence/shared";
import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface TaskSearchHit {
  taskId: string;
  title: string;
}

/**
 * Turn free user text into a safe FTS5 MATCH query: strip punctuation/operators,
 * lower-case, and prefix-match each word (palette-friendly). "" if nothing usable.
 */
export function sanitizeFtsQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return terms.map((t) => `${t}*`).join(" ");
}

/** Ranked task hits (id + title + status) for the search box / ⌘K palette. */
export function searchTaskHits(db: Db, query: string, limit = 20): SearchHit[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  // MATCH must reference the bare FTS table (no join alias), so match in a subquery
  // and join tasks for the status.
  const rows = db.all(
    sql`SELECT t.id as taskId, t.title as title, t.status as status
        FROM (
          SELECT task_id, rank FROM tasks_fts WHERE tasks_fts MATCH ${match} ORDER BY rank LIMIT ${limit}
        ) m
        JOIN tasks t ON t.id = m.task_id
        ORDER BY m.rank`,
  ) as Array<{ taskId: string; title: string; status: string }>;
  return rows;
}

/**
 * Full-text search over task title + body (FTS5, ranked by relevance).
 * `query` is FTS5 MATCH syntax; the search UI (1.13) will sanitize user input
 * for special characters before it reaches here.
 */
export function searchTasks(db: Db, query: string, limit = 50): TaskSearchHit[] {
  const rows = db.all(
    sql`SELECT task_id, title FROM tasks_fts WHERE tasks_fts MATCH ${query} ORDER BY rank LIMIT ${limit}`,
  ) as { task_id: string; title: string }[];
  return rows.map((r) => ({ taskId: r.task_id, title: r.title }));
}

/**
 * Recovery helper: rebuild the FTS index from the canonical `tasks` rows.
 * Live per-row sync is handled by DB triggers (see migration 0001); a full
 * reindex from the markdown source of truth lands in 0.4/0.5, and transcript /
 * memory indexing in Phase 4 (those sync hooks are stubbed for now).
 */
export function rebuildTaskFts(db: Db): void {
  db.run(sql`DELETE FROM tasks_fts`);
  db.run(sql`INSERT INTO tasks_fts(task_id, title, body) SELECT id, title, body FROM tasks`);
}
