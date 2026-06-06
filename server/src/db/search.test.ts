import { beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrateDb, openDb, type Db } from "./client";
import { sanitizeFtsQuery, searchTaskHits, searchTasks } from "./search";
import { tasks } from "./schema";

let db: Db;

beforeAll(() => {
  db = openDb(":memory:");
  migrateDb(db);
});

test("FTS returns a task by a word in its body", () => {
  const id = crypto.randomUUID();
  db.insert(tasks)
    .values({ id, title: "Wire the gateway", body: "Add a websocket broadcast hub" })
    .run();
  db.insert(tasks)
    .values({ id: crypto.randomUUID(), title: "Write docs", body: "Update the readme" })
    .run();

  const hits = searchTasks(db, "websocket");
  expect(hits).toHaveLength(1);
  expect(hits[0]?.taskId).toBe(id);
  expect(hits[0]?.title).toBe("Wire the gateway");

  // Title is indexed too; diacritics are folded (remove_diacritics 2).
  expect(searchTasks(db, "gateway").map((h) => h.taskId)).toContain(id);
});

test("searchTaskHits finds a task by body text (prefix + sanitized), with status", () => {
  const id = crypto.randomUUID();
  db.insert(tasks)
    .values({ id, title: "Refactor parser", body: "rework the tokenizer pipeline", status: "ready" })
    .run();

  // prefix match on a body word
  const hits = searchTaskHits(db, "token");
  expect(hits.find((h) => h.taskId === id)).toMatchObject({ title: "Refactor parser", status: "ready" });

  // punctuation/operators are sanitized away (no FTS syntax error)
  expect(() => searchTaskHits(db, '"tokenizer" AND (')).not.toThrow();
  expect(searchTaskHits(db, "tokenizer").map((h) => h.taskId)).toContain(id);

  // empty / junk queries return nothing rather than erroring
  expect(searchTaskHits(db, "   ")).toHaveLength(0);
  expect(sanitizeFtsQuery("Hello, World!")).toBe("hello* world*");
});

test("triggers keep FTS in sync on update and delete", () => {
  const id = crypto.randomUUID();
  db.insert(tasks).values({ id, title: "Analyza", body: "seznameni s kodem" }).run();
  expect(searchTasks(db, "seznameni").map((h) => h.taskId)).toContain(id);

  db.update(tasks).set({ body: "completely different content" }).where(eq(tasks.id, id)).run();
  expect(searchTasks(db, "seznameni")).toHaveLength(0);
  expect(searchTasks(db, "different").map((h) => h.taskId)).toContain(id);

  db.delete(tasks).where(eq(tasks.id, id)).run();
  expect(searchTasks(db, "different")).toHaveLength(0);
});
