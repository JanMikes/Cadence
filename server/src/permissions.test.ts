import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeEvent } from "@cadence/shared";
import { migrateDb, openDb, type Db } from "./db/client";
import { createProject, updateProject } from "./projects";
import { claudePermissionMode } from "./sessions";
import { openSession } from "./spawn";
import { bootstrap, DEFAULT_SETTINGS, writeSettings } from "./store/store";
import { createTask, resolvePermissionMode, updateTask } from "./tasks";

const MOCK_CMD = [process.execPath, join(import.meta.dir, "testing", "mock-claude.ts")];

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-perm-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("Cadence modes map to the right claude --permission-mode", () => {
  expect(claudePermissionMode("auto")).toBe("acceptEdits");
  expect(claudePermissionMode("manual")).toBe("default");
  expect(claudePermissionMode("dangerous")).toBe("bypassPermissions");
  expect(claudePermissionMode(undefined)).toBe("default"); // safe fallback
  expect(claudePermissionMode("acceptEdits")).toBe("acceptEdits"); // raw passthrough
});

test("permission resolves task ?? project ?? global", () => {
  // global default
  const task = createTask(db, { title: "t" });
  expect(resolvePermissionMode(db, task.id)).toBe("auto"); // default global

  writeSettings({
    ...DEFAULT_SETTINGS,
    global: { ...DEFAULT_SETTINGS.global, defaultPermissionMode: "manual" },
  });
  expect(resolvePermissionMode(db, task.id)).toBe("manual"); // global override

  // project default beats global
  createProject(db, { name: "Acme", defaultPermissionMode: "dangerous" });
  updateTask(db, task.id, { project: "acme" });
  expect(resolvePermissionMode(db, task.id)).toBe("dangerous");

  // task override beats project
  updateTask(db, task.id, { permissionMode: "auto" });
  expect(resolvePermissionMode(db, task.id)).toBe("auto");

  // clearing the task override falls back to project
  updateTask(db, task.id, { permissionMode: null });
  expect(resolvePermissionMode(db, task.id)).toBe("dangerous");

  // sanity: updateProject can change the project default
  updateProject(db, "acme", { defaultPermissionMode: "manual" });
  expect(resolvePermissionMode(db, task.id)).toBe("manual");
});

test("the mapped claude --permission-mode reaches the spawned binary", async () => {
  // dangerous (Cadence) -> bypassPermissions (claude) reaches the process args
  let init: ClaudeEvent | undefined;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 5000);
    const handle = openSession({
      sessionId: "perm1",
      cwd: home,
      command: MOCK_CMD,
      permissionMode: claudePermissionMode("dangerous"),
      onEvent: (e) => {
        if (e.type === "system") init = e;
        if (e.type === "result") handle.close();
      },
      onClose: () => {
        clearTimeout(timer);
        resolve();
      },
      onError: reject,
    });
    handle.send("hi");
  });
  expect((init as { permissionMode?: string } | undefined)?.permissionMode).toBe("bypassPermissions");
});
