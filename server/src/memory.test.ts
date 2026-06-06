import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { composeContext } from "./context";
import {
  appendMemoryNote,
  listLearnedEntries,
  listMemoryFiles,
  readGlobalMemory,
  readProjectMemory,
  revertLearnedEntry,
  safeName,
  writeMemoryFile,
  writeProjectMemory,
} from "./memory";
import { createProject } from "./projects";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-memory-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("safeName strips path traversal + unsafe chars", () => {
  expect(safeName("../../etc/passwd")).toBe("etcpasswd");
  expect(safeName("communication")).toBe("communication");
});

test("global memory round-trips; MEMORY.md sorts first", () => {
  writeMemoryFile("communication", "Be terse. Czech/English ok.");
  writeMemoryFile("MEMORY", "# Index");
  const files = listMemoryFiles();
  expect(files[0]?.name).toBe("MEMORY"); // index first
  expect(files.map((f) => f.name).sort()).toEqual(["MEMORY", "communication"]);
  expect(readGlobalMemory()).toContain("Be terse");
});

test("per-project memory round-trips", () => {
  const p = createProject(db, { name: "API" });
  expect(readProjectMemory(p.slug)).toBe("");
  writeProjectMemory(p.slug, "Run `bun test`. DB must be up for delivery.");
  expect(readProjectMemory(p.slug)).toContain("bun test");
});

test("learned feed: list bullets + revert one by index", () => {
  appendMemoryNote("learned", "Jan trims priorities up by one");
  appendMemoryNote("learned", "Delivery needs the DB up");
  appendMemoryNote("learned", "Prefer small diffs");

  let entries = listLearnedEntries();
  expect(entries.map((e) => e.text)).toEqual([
    "Jan trims priorities up by one",
    "Delivery needs the DB up",
    "Prefer small diffs",
  ]);

  expect(revertLearnedEntry("learned", 1)).toBe(true); // remove the middle one
  entries = listLearnedEntries();
  expect(entries.map((e) => e.text)).toEqual(["Jan trims priorities up by one", "Prefer small diffs"]);

  expect(revertLearnedEntry("learned", 9)).toBe(false); // out of range
});

test("composeContext folds in global + per-project memory", () => {
  writeMemoryFile("rules", "Jan trims priorities up by one.");
  const p = createProject(db, { name: "Web" });
  writeProjectMemory(p.slug, "Use Tailwind tokens, never raw hex.");
  const task = createTask(db, { title: "T" });
  updateTask(db, task.id, { project: p.slug });
  const composed = composeContext(db, { taskId: task.id, projectId: p.id });
  expect(composed).toContain("Memory (learned, cross-project)");
  expect(composed).toContain("trims priorities");
  expect(composed).toContain("Project memory: Web");
  expect(composed).toContain("Tailwind tokens");
});
