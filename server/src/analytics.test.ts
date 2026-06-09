import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAnalytics } from "./analytics";
import { type Db, migrateDb, openDb } from "./db/client";
import { sessions } from "./db/schema";
import { createProject } from "./projects";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-analytics-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("computeAnalytics aggregates per-project tasks/done/cost + status breakdown", () => {
  const api = createProject(db, { name: "API" });
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  updateTask(db, a.id, { project: api.slug });
  updateTask(db, a.id, { status: "ready" });
  updateTask(db, a.id, { status: "done" }); // a is done, on API
  updateTask(db, b.id, { project: api.slug }); // b stays inbox, on API

  // two sessions on the API project with cost
  for (const cost of [0.5, 1.25]) {
    db.insert(sessions)
      .values({ id: crypto.randomUUID(), role: "implementer", cwd: "/tmp", costUsd: cost, projectId: api.id })
      .run();
  }

  const s = computeAnalytics(db, Date.parse("2026-06-06T12:00:00Z"));
  const apiRow = s.byProject.find((p) => p.projectName === "API");
  expect(apiRow?.tasks).toBe(2);
  expect(apiRow?.done).toBe(1);
  expect(apiRow?.sessions).toBe(2);
  expect(apiRow?.costUsd).toBeCloseTo(1.75, 5);

  expect(s.totalCostUsd).toBeCloseTo(1.75, 5);
  expect(s.totalSessions).toBe(2);
  expect(s.byStatus.done).toBe(1);
  expect(s.doneTasks).toBe(1);
});

test("throughput buckets completions per day across the window", () => {
  // updateTask stamps the status_change event with the real wall clock, so the
  // window's "now" must come from the same clock or the completion falls outside
  // it (a hardcoded date silently drifts out of range as real time moves on).
  const now = Date.now();
  const t = createTask(db, { title: "Ship" });
  updateTask(db, t.id, { status: "ready" });
  updateTask(db, t.id, { status: "done" }); // status_change → done recorded now

  const s = computeAnalytics(db, now, 14);
  expect(s.throughput).toHaveLength(14);
  const today = s.throughput.at(-1);
  expect(today?.completed).toBe(1); // the completion lands on the last (today) bucket
  expect(s.throughput.reduce((sum, d) => sum + d.completed, 0)).toBe(1);
});

test("an unassigned task lands in the Unassigned bucket", () => {
  createTask(db, { title: "Orphan" });
  const s = computeAnalytics(db);
  expect(s.byProject.find((p) => p.projectName === "Unassigned")?.tasks).toBe(1);
});
