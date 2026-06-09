import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { migrateDb, openDb, type Db } from "./db/client";
import { searchTasks } from "./db/search";
import { paths } from "./store/paths";
import { appendContext, bootstrap, readContext } from "./store/store";
import { createTask, deriveTitle, getTask, getTaskDetail, listTasks, updateTask } from "./tasks";

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

test("createTask is description-first: derives a provisional title and flags it", () => {
  const task = createTask(db, { body: "Refactor the websocket hub\nIt leaks subscriptions." });

  expect(task.title).toBe("Refactor the websocket hub"); // first description line
  expect(getTaskDetail(db, task.id)?.titleGenerated).toBe(true); // awaiting a real name

  // An explicit title is never flagged.
  const named = createTask(db, { title: "Named", body: "whatever" });
  expect(getTaskDetail(db, named.id)?.titleGenerated).toBe(false);

  // Capturing nothing at all is a programming error.
  expect(() => createTask(db, {})).toThrow();
});

test("setting a title (user or agent) clears the titleGenerated placeholder flag", () => {
  const task = createTask(db, { body: "describe only" });
  expect(getTaskDetail(db, task.id)?.titleGenerated).toBe(true);

  updateTask(db, task.id, { title: "A proper name" });
  const detail = getTaskDetail(db, task.id);
  expect(detail?.title).toBe("A proper name");
  expect(detail?.titleGenerated).toBe(false);

  // An unrelated patch keeps the flag.
  const other = createTask(db, { body: "still unnamed" });
  updateTask(db, other.id, { priority: "P2" });
  expect(getTaskDetail(db, other.id)?.titleGenerated).toBe(true);
});

test("deriveTitle squashes whitespace and caps at a word boundary", () => {
  expect(deriveTitle("Fix the thing")).toBe("Fix the thing");
  expect(deriveTitle("\n\n  spaced   out\nrest")).toBe("spaced out"); // first non-empty line
  const long = "Implement the brand new permission inheritance resolution pipeline end to end";
  const derived = deriveTitle(long);
  expect(derived.length).toBeLessThanOrEqual(61); // 60 + ellipsis
  expect(derived.endsWith("…")).toBe(true);
  expect(deriveTitle("")).toBe("");
});

test("listTasks returns captured tasks newest-first and filters by status", () => {
  const a = createTask(db, { title: "First" });
  const b = createTask(db, { title: "Second" });

  const inbox = listTasks(db, { status: "inbox" });
  expect(inbox.map((t) => t.id)).toEqual([b.id, a.id]); // newest first
  expect(listTasks(db, { status: "done" })).toHaveLength(0);
  expect(listTasks(db)).toHaveLength(2);
});

test("updateTask persists status + fields to markdown and the index", () => {
  const task = createTask(db, { title: "Move me" });

  const updated = updateTask(db, task.id, {
    status: "ready",
    priority: "high",
    estimate: 45,
    labels: ["infra", "backend"],
    deadline: Date.parse("2026-08-01"),
  });
  expect(updated?.status).toBe("ready");
  expect(updated?.labels).toEqual(["infra", "backend"]);

  // index reflects the change
  expect(getTask(db, task.id)?.status).toBe("ready");
  expect(getTask(db, task.id)?.deadline).toBe(Date.parse("2026-08-01"));
  // markdown is the source of truth (labels live there)
  expect(getTaskDetail(db, task.id)?.labels).toEqual(["infra", "backend"]);
  // status survives a re-read of the file
  const md = readFileSync(paths.taskFile(task.id), "utf8");
  expect(md).toContain("status: ready");

  expect(updateTask(db, "no-such-id", { status: "done" })).toBeNull();
});

test("context channel appends notes to context.md (append-only)", () => {
  const task = createTask(db, { title: "Has context" });
  expect(readContext(task.id)).toBe("");

  appendContext(task.id, "first note", new Date("2026-06-06T10:00:00Z"));
  appendContext(task.id, "second note", new Date("2026-06-06T11:00:00Z"));

  const content = readContext(task.id);
  expect(content).toContain("first note");
  expect(content).toContain("second note");
  expect(content.indexOf("first note")).toBeLessThan(content.indexOf("second note")); // append order
  expect(content).toContain("2026-06-06T10:00:00"); // timestamped
});
