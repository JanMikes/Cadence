-- Custom SQL migration file, put your code below! --
-- Full-text search over task text (FTS5). Transcripts/memory get added in Phase 4.
-- Standalone FTS table (stores its own copy of the text) kept in sync with `tasks`
-- by AFTER triggers, so search stays correct no matter who writes a task row
-- (the app reindexer in 0.4/0.5, a migration, or a direct insert).

CREATE VIRTUAL TABLE tasks_fts USING fts5(
  task_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(task_id, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER tasks_fts_au AFTER UPDATE ON tasks BEGIN
  UPDATE tasks_fts SET title = new.title, body = new.body WHERE task_id = old.id;
END;
