import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import {
  createProject,
  getProject,
  listProjects,
  resolveProjectAutonomy,
  updateProject,
} from "./projects";
import { paths } from "./store/paths";
import { bootstrap, readSettings, writeSettings } from "./store/store";
import { createTask, getTask, resolveTaskCwd, updateTask } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-proj-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("createProject writes projects/<slug>.md + an index row", () => {
  const p = createProject(db, { name: "Acme Web", rootPath: "/tmp/acme", systemPrompt: "Be terse." });

  expect(p.slug).toBe("acme-web");
  expect(p.defaultPermissionMode).toBe("auto");
  expect(existsSync(paths.projectFile("acme-web"))).toBe(true);
  expect(getProject(db, "acme-web")?.systemPrompt).toBe("Be terse.");
  expect(listProjects(db).map((x) => x.slug)).toContain("acme-web");
});

test("agentPrompts round-trip markdown + index; blanks drop; empty map clears (§6.3.b)", () => {
  const p = createProject(db, {
    name: "Prompts",
    agentPrompts: { discovery: "Prefer bun APIs.", planner: "   " }, // blank value is dropped
  });
  expect(p.agentPrompts).toEqual({ discovery: "Prefer bun APIs." });
  expect(getProject(db, p.slug)?.agentPrompts).toEqual({ discovery: "Prefer bun APIs." });

  // PATCH replaces the whole map (the UI always sends the full record).
  const updated = updateProject(db, p.slug, { agentPrompts: { implementer: "Run make check." } });
  expect(updated?.agentPrompts).toEqual({ implementer: "Run make check." });

  // Clearing every field clears the layer entirely (null, not {}).
  expect(updateProject(db, p.slug, { agentPrompts: {} })?.agentPrompts).toBeNull();
  expect(updateProject(db, p.slug, { agentPrompts: null })?.agentPrompts).toBeNull();
});

test("autonomy round-trips through the index and defaults to null (inherit)", () => {
  const p = createProject(db, { name: "Auto Proj" });
  expect(p.autonomy).toBeNull();
  const off = updateProject(db, p.slug, { autonomy: false });
  expect(off?.autonomy).toBe(false);
  expect(getProject(db, p.slug)?.autonomy).toBe(false);
});

test("resolveProjectAutonomy resolves project ?? global (§9.1)", () => {
  const settings = readSettings();
  writeSettings({ ...settings, global: { ...settings.global, autonomy: true } });

  // unassigned → follows the global switch
  expect(resolveProjectAutonomy(db, null)).toBe(true);

  const inherit = createProject(db, { name: "Inherit" });
  const off = createProject(db, { name: "Off", autonomy: false });
  expect(resolveProjectAutonomy(db, inherit.id)).toBe(true); // null → inherit (global on)
  expect(resolveProjectAutonomy(db, off.id)).toBe(false); // explicit off overrides global on

  // flip global off: an explicitly-on project still opts in
  writeSettings({ ...settings, global: { ...settings.global, autonomy: false } });
  const on = createProject(db, { name: "On", autonomy: true });
  expect(resolveProjectAutonomy(db, null)).toBe(false);
  expect(resolveProjectAutonomy(db, on.id)).toBe(true);
});

test("duplicate names get unique slugs", () => {
  const a = createProject(db, { name: "Acme" });
  const b = createProject(db, { name: "Acme" });
  expect(a.slug).toBe("acme");
  expect(b.slug).toBe("acme-2");
});

test("updateProject patches config + systemPrompt", () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/a" });
  const up = updateProject(db, "acme", {
    rootPath: "/tmp/b",
    defaultPermissionMode: "manual",
    systemPrompt: "New prompt.",
  });
  expect(up?.rootPath).toBe("/tmp/b");
  expect(up?.defaultPermissionMode).toBe("manual");
  expect(getProject(db, "acme")?.systemPrompt).toBe("New prompt.");
  expect(updateProject(db, "nope", { name: "x" })).toBeNull();
});

test("assign a task to a project; cwd resolves to the project rootPath", () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/acme-root" });
  const task = createTask(db, { title: "Do a thing" });

  // unassigned -> cwd falls back to the process cwd
  expect(resolveTaskCwd(db, task.id)).toBe(process.cwd());

  const assigned = updateTask(db, task.id, { project: "acme" });
  expect(assigned).not.toBeNull();
  expect(getTask(db, task.id)?.projectId).toBeTruthy(); // slug resolved to FK id
  expect(resolveTaskCwd(db, task.id)).toBe("/tmp/acme-root");

  // unassign
  updateTask(db, task.id, { project: null });
  expect(getTask(db, task.id)?.projectId).toBeNull();
});
