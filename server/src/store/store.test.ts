import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrateDb, openDb, type Db } from "../db/client";
import { searchTasks } from "../db/search";
import { projects, tasks } from "../db/schema";
import { paths } from "./paths";
import {
  appendRunReport,
  bootstrap,
  readRunReports,
  readSettings,
  readTask,
  reindexProject,
  reindexTask,
  writeProject,
  writeTask,
} from "./store";

let db: Db;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-store-"));
  process.env.CADENCE_HOME = home; // both storage + db resolve under the temp home
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterAll(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("bootstrap creates the dir tree + default settings.json", () => {
  expect(existsSync(paths.tasksDir())).toBe(true);
  expect(existsSync(paths.projectsDir())).toBe(true);
  expect(existsSync(paths.settings())).toBe(true);
  expect(readSettings().global.defaultPermissionMode).toBe("auto");
});

test("task folder round-trips: write md -> reindex -> DB row matches frontmatter", () => {
  writeProject({ id: "p1", name: "Acme", slug: "acme", rootPath: "/tmp/acme" }, "Be terse.");
  reindexProject(db, "acme");
  expect(db.select().from(projects).where(eq(projects.id, "p1")).get()?.systemPrompt).toBe(
    "Be terse.",
  );

  const taskId = crypto.randomUUID();
  const deadline = "2026-07-01";
  writeTask(
    {
      id: taskId,
      title: "Add websocket hub",
      status: "ready",
      priority: "high",
      deadline,
      estimate: 90,
      project: "acme",
      labels: ["infra", "backend"],
    },
    "Broadcast events to all connected clients.",
  );
  reindexTask(db, taskId);

  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  expect(row?.title).toBe("Add websocket hub");
  expect(row?.status).toBe("ready");
  expect(row?.priority).toBe("high");
  expect(row?.estimate).toBe(90);
  expect(row?.body).toContain("Broadcast events");
  expect(row?.deadline).toBe(Date.parse(deadline));
  expect(row?.projectId).toBe("p1"); // project slug resolved to FK id

  // Markdown stays the source of truth (labels live there, not in the index).
  expect(readTask(taskId).data.labels).toEqual(["infra", "backend"]);

  // The reindex INSERT fired the FTS trigger.
  expect(searchTasks(db, "websocket").map((h) => h.taskId)).toContain(taskId);
});

test("reindex is idempotent and reflects edits", () => {
  const taskId = crypto.randomUUID();
  writeTask({ id: taskId, title: "First", status: "inbox" }, "v1");
  reindexTask(db, taskId);
  expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.title).toBe("First");

  writeTask({ id: taskId, title: "Second", status: "triaged" }, "v2");
  reindexTask(db, taskId); // UPDATE path
  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  expect(row?.title).toBe("Second");
  expect(row?.status).toBe("triaged");
  expect(row?.body).toBe("v2");
});

test("run reports: append + read round-trip, newest last, hand-edit tolerant", () => {
  const id = "task-runs-1";
  appendRunReport(id, {
    at: 1000,
    role: "implementer",
    status: "done",
    costUsd: 0.42,
    sessionId: "s-1",
    model: "opus",
    output: "Implemented the thing.\n\n## Notes\nwith a heading inside the output",
  });
  appendRunReport(id, {
    at: 2000,
    role: "verifier",
    status: "failed",
    costUsd: null,
    sessionId: "s-2",
    model: null,
    output: "",
  });

  const reports = readRunReports(id);
  expect(reports.length).toBe(2);
  expect(reports[0]).toMatchObject({ at: 1000, role: "implementer", status: "done", costUsd: 0.42, sessionId: "s-1" });
  // the agent's own markdown headings survive; only our decorative heading is stripped
  expect(reports[0]?.output).toContain("## Notes");
  expect(reports[0]?.output).toContain("Implemented the thing.");
  expect(reports[1]).toMatchObject({ role: "verifier", status: "failed", costUsd: null });
  expect(reports[1]?.output).toBe("(no output)");

  expect(readRunReports("never-ran")).toEqual([]);
});
