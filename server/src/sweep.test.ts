import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Db, migrateDb, openDb } from "./db/client";
import { tasks } from "./db/schema";
import { bootstrap } from "./store/store";
import { runSweep } from "./sweep";
import { createTask, updateTask } from "./tasks";

let db: Db;
let home: string;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-sweep-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** Force a task's index updatedAt (the staleness signal). */
function setUpdatedAt(id: string, ms: number) {
  db.update(tasks).set({ updatedAt: ms }).where(eq(tasks.id, id)).run();
}

test("runSweep flags tasks idle past the threshold", () => {
  const fresh = createTask(db, { title: "Fresh" });
  const stale = createTask(db, { title: "Stale" });
  setUpdatedAt(fresh.id, NOW - 2 * DAY);
  setUpdatedAt(stale.id, NOW - 10 * DAY);

  const report = runSweep(db, NOW, { staleDays: 7 });
  const ids = report.findings.map((f) => f.taskId);
  expect(ids).toContain(stale.id);
  expect(ids).not.toContain(fresh.id);
  expect(report.findings.find((f) => f.taskId === stale.id)?.kind).toBe("stale");
});

test("runSweep flags at-risk/overdue deadlines (taking precedence over stale)", () => {
  const overdue = createTask(db, { title: "Overdue" });
  updateTask(db, overdue.id, { deadline: NOW - DAY });
  setUpdatedAt(overdue.id, NOW - 30 * DAY); // also stale, but deadline wins

  const report = runSweep(db, NOW, { staleDays: 7, atRiskDays: 2 });
  const f = report.findings.find((x) => x.taskId === overdue.id);
  expect(f?.kind).toBe("at_risk");
  expect(f?.detail).toContain("Overdue");
  // only one finding for that task
  expect(report.findings.filter((x) => x.taskId === overdue.id)).toHaveLength(1);
});

test("runSweep ignores done/cancelled tasks", () => {
  const done = createTask(db, { title: "Done" });
  updateTask(db, done.id, { status: "ready" });
  updateTask(db, done.id, { status: "done" });
  setUpdatedAt(done.id, NOW - 30 * DAY);
  expect(runSweep(db, NOW).findings.map((f) => f.taskId)).not.toContain(done.id);
});
