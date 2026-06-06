import { beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrateDb, openDb, type Db } from "./client";
import {
  events,
  fleets,
  projects,
  sessions,
  suggestions,
  taskDeps,
  tasks,
} from "./schema";

let db: Db;

beforeAll(() => {
  // In-memory DB keeps the test hermetic — never touches the real ~/.cadence.
  db = openDb(":memory:");
  migrateDb(db);
});

test("schema migrates and round-trips one row per table", () => {
  const projectId = crypto.randomUUID();
  db.insert(projects).values({ id: projectId, name: "Acme", slug: "acme" }).run();

  const fleetId = crypto.randomUUID();
  db.insert(fleets).values({ id: fleetId, name: "Acme Fleet", slug: "acme-fleet" }).run();

  const taskA = crypto.randomUUID();
  const taskB = crypto.randomUUID();
  db.insert(tasks).values({ id: taskA, title: "Wire the gateway", projectId }).run();
  db.insert(tasks).values({ id: taskB, title: "Add global search" }).run();

  db.insert(taskDeps).values({ blockerTaskId: taskA, blockedTaskId: taskB }).run();

  const sessionId = crypto.randomUUID();
  db.insert(sessions)
    .values({ id: sessionId, taskId: taskA, projectId, role: "chat", cwd: "/tmp/acme" })
    .run();

  db.insert(events)
    .values({ taskId: taskA, sessionId, type: "captured", payload: JSON.stringify({ ok: true }) })
    .run();

  const suggestionId = crypto.randomUUID();
  db.insert(suggestions)
    .values({
      id: suggestionId,
      entityType: "task",
      entityId: taskA,
      field: "priority",
      suggestedValue: JSON.stringify("high"),
      source: "triage",
    })
    .run();

  // --- read back one row per table; assert column defaults applied ---
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  expect(project?.name).toBe("Acme");
  expect(project?.defaultPermissionMode).toBe("auto");
  expect(project?.createdAt ?? 0).toBeGreaterThan(0);

  expect(db.select().from(fleets).where(eq(fleets.id, fleetId)).get()?.slug).toBe("acme-fleet");

  const task = db.select().from(tasks).where(eq(tasks.id, taskA)).get();
  expect(task?.status).toBe("inbox");
  expect(task?.projectId).toBe(projectId);

  expect(db.select().from(taskDeps).all()).toHaveLength(1);

  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  expect(session?.kind).toBe("warm");
  expect(session?.costUsd).toBe(0);

  const event = db.select().from(events).where(eq(events.taskId, taskA)).get();
  expect(event?.type).toBe("captured");
  expect(event?.id ?? 0).toBeGreaterThan(0);

  expect(db.select().from(suggestions).where(eq(suggestions.id, suggestionId)).get()?.status).toBe(
    "suggested",
  );
});

test("foreign keys are enforced", () => {
  expect(() =>
    db
      .insert(events)
      .values({ taskId: crypto.randomUUID(), type: "orphan" })
      .run(),
  ).toThrow();
});
