import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { addDependency, getDeps, getSubtasks, isBlocked, removeDependency, wouldCycle } from "./deps";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-deps-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("addDependency records the edge both directions (blockedBy / blocks)", () => {
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  // B must finish before A
  expect(addDependency(db, a.id, b.id)).toEqual({ ok: true });

  expect(getDeps(db, a.id).blockedBy.map((t) => t.id)).toEqual([b.id]);
  expect(getDeps(db, b.id).blocks.map((t) => t.id)).toEqual([a.id]);
});

test("a dependency cycle is refused", () => {
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  addDependency(db, a.id, b.id); // B blocks A
  expect(wouldCycle(db, b.id, a.id)).toBe(true); // adding A blocks B → cycle
  expect(addDependency(db, b.id, a.id)).toEqual({ ok: false, reason: "that would create a dependency cycle" });
  expect(addDependency(db, a.id, a.id)).toMatchObject({ ok: false }); // self-edge
});

test("removeDependency clears the edge", () => {
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  addDependency(db, a.id, b.id);
  expect(removeDependency(db, a.id, b.id)).toEqual({ ok: true });
  expect(getDeps(db, a.id).blockedBy).toHaveLength(0);
  expect(getDeps(db, b.id).blocks).toHaveLength(0);
});

test("isBlocked is true until every blocker is done", () => {
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  addDependency(db, a.id, b.id);
  expect(isBlocked(db, a.id)).toBe(true);
  updateTask(db, b.id, { status: "ready" });
  updateTask(db, b.id, { status: "done" });
  expect(isBlocked(db, a.id)).toBe(false);
});

test("getSubtasks returns children by parentTask", () => {
  const parent = createTask(db, { title: "Parent" });
  const child1 = createTask(db, { title: "Child 1" });
  const child2 = createTask(db, { title: "Child 2" });
  updateTask(db, child1.id, { parentTask: parent.id });
  updateTask(db, child2.id, { parentTask: parent.id });
  expect(getSubtasks(db, parent.id).map((t) => t.id).sort()).toEqual([child1.id, child2.id].sort());
});
