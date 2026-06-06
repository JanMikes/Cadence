import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface TaskSearchHit {
  taskId: string;
  title: string;
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
