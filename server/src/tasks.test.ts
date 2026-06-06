import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import { searchTasks } from "./db/search";
import { paths } from "./store/paths";
import { bootstrap } from "./store/store";
import { createTask, getTask, listTasks } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-tasks-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("createTask writes task.md + an index row, landing in Inbox", () => {
  const task = createTask(db, { title: "Wire the gateway", body: "broadcast events" });

  expect(task.status).toBe("inbox");
  expect(task.title).toBe("Wire the gateway");
  expect(existsSync(paths.taskFile(task.id))).toBe(true); // file on disk
  expect(getTask(db, task.id)?.title).toBe("Wire the gateway"); // index row
  expect(searchTasks(db, "broadcast").map((h) => h.taskId)).toContain(task.id); // FTS
});

test("listTasks returns captured tasks newest-first and filters by status", () => {
  const a = createTask(db, { title: "First" });
  const b = createTask(db, { title: "Second" });

  const inbox = listTasks(db, { status: "inbox" });
  expect(inbox.map((t) => t.id)).toEqual([b.id, a.id]); // newest first
  expect(listTasks(db, { status: "done" })).toHaveLength(0);
  expect(listTasks(db)).toHaveLength(2);
});
