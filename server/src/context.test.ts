import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeContext } from "./context";
import { migrateDb, openDb, type Db } from "./db/client";
import { createProject } from "./projects";
import { appendContext, bootstrap, DEFAULT_SETTINGS, saveAttachment, writeSettings } from "./store/store";
import { createTask, getTask, updateTask } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-ctx-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("composeContext layers global → project → task context, most-general first", () => {
  writeSettings({
    ...DEFAULT_SETTINGS,
    global: { ...DEFAULT_SETTINGS.global, systemPrompt: "GLOBAL-MARKER-AAA" },
  });
  createProject(db, { name: "Acme", systemPrompt: "PROJECT-MARKER-ZEBRA" });
  const task = createTask(db, { title: "Do it" });
  updateTask(db, task.id, { project: "acme" });
  appendContext(task.id, "CONTEXT-NOTE-FOO");

  const projectId = getTask(db, task.id)?.projectId ?? null;
  const composed = composeContext(db, { taskId: task.id, projectId });

  // all three layers present
  expect(composed).toContain("GLOBAL-MARKER-AAA");
  expect(composed).toContain("PROJECT-MARKER-ZEBRA");
  expect(composed).toContain("CONTEXT-NOTE-FOO");

  // ordered most-general → most-specific (later wins)
  expect(composed.indexOf("GLOBAL-MARKER-AAA")).toBeLessThan(composed.indexOf("PROJECT-MARKER-ZEBRA"));
  expect(composed.indexOf("PROJECT-MARKER-ZEBRA")).toBeLessThan(composed.indexOf("CONTEXT-NOTE-FOO"));
  expect(composed).toContain("Project: Acme");
});

test("composeContext is empty when there's nothing to add", () => {
  const task = createTask(db, { title: "Bare" });
  expect(composeContext(db, { taskId: task.id, projectId: null })).toBe("");
});

test("composeContext lists attachments by absolute path so agents can Read them", () => {
  const task = createTask(db, { title: "With files" });
  const saved = saveAttachment(task.id, "screenshot.png", new Uint8Array([1, 2]));

  const composed = composeContext(db, { taskId: task.id, projectId: null });
  expect(composed).toContain("Task attachments");
  expect(composed).toContain(saved.path); // absolute path, terminal-paste parity
  expect(composed).toContain("image/png");
});
