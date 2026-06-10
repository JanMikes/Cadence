import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeNextRun, describeSchedule } from "@cadence/shared";
import { migrateDb, openDb, type Db } from "./db/client";
import {
  createRecurring,
  deleteRecurring,
  getRecurring,
  listRecurring,
  runRecurringTick,
  startRecurringScheduler,
  triggerRecurring,
  updateRecurring,
} from "./recurring";
import { paths } from "./store/paths";
import { bootstrap, readContext, readRecurring, reindexRecurring, writeProject, writeRecurring, reindexProject } from "./store/store";
import { getTask, listTasks } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-recurring-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

const at = (y: number, mo: number, d: number, h = 0, min = 0) =>
  new Date(y, mo - 1, d, h, min, 0, 0).getTime();

// ------------------------------------------------------------ schedule math

test("computeNextRun daily: today if the time is still ahead, else tomorrow", () => {
  const s = { cadence: "daily" as const, time: "09:00" };
  expect(computeNextRun(s, at(2026, 6, 10, 8, 0))).toBe(at(2026, 6, 10, 9, 0));
  expect(computeNextRun(s, at(2026, 6, 10, 9, 0))).toBe(at(2026, 6, 11, 9, 0)); // strictly after
  expect(computeNextRun(s, at(2026, 6, 10, 22, 30))).toBe(at(2026, 6, 11, 9, 0));
});

test("computeNextRun weekly: lands on the picked weekday, wrapping a full week when passed", () => {
  // 2026-06-10 is a Wednesday (getDay 3).
  const monday = { cadence: "weekly" as const, dayOfWeek: 1, time: "10:00" };
  expect(computeNextRun(monday, at(2026, 6, 10, 12, 0))).toBe(at(2026, 6, 15, 10, 0));
  const wednesday = { cadence: "weekly" as const, dayOfWeek: 3, time: "10:00" };
  expect(computeNextRun(wednesday, at(2026, 6, 10, 9, 0))).toBe(at(2026, 6, 10, 10, 0)); // later today
  expect(computeNextRun(wednesday, at(2026, 6, 10, 10, 0))).toBe(at(2026, 6, 17, 10, 0)); // +7
});

test("computeNextRun monthly: clamps day 31 to short months instead of skipping them", () => {
  const s = { cadence: "monthly" as const, dayOfMonth: 31, time: "09:00" };
  expect(computeNextRun(s, at(2026, 1, 31, 9, 0))).toBe(at(2026, 2, 28, 9, 0)); // Feb 2026: 28 days
  expect(computeNextRun(s, at(2026, 2, 28, 9, 0))).toBe(at(2026, 3, 31, 9, 0));
  const mid = { cadence: "monthly" as const, dayOfMonth: 15, time: "08:30" };
  expect(computeNextRun(mid, at(2026, 6, 10, 0, 0))).toBe(at(2026, 6, 15, 8, 30)); // this month
  expect(computeNextRun(mid, at(2026, 6, 15, 8, 30))).toBe(at(2026, 7, 15, 8, 30)); // next month
});

test("computeNextRun survives a malformed time (hand-edited markdown) via the 09:00 fallback", () => {
  const s = { cadence: "daily" as const, time: "not-a-time" };
  expect(computeNextRun(s, at(2026, 6, 10, 8, 0))).toBe(at(2026, 6, 10, 9, 0));
});

test("describeSchedule speaks plain language", () => {
  expect(describeSchedule({ cadence: "daily", time: "09:00" })).toBe("Every day at 09:00");
  expect(describeSchedule({ cadence: "weekly", dayOfWeek: 1, time: "10:00" })).toBe(
    "Every Monday at 10:00",
  );
  expect(describeSchedule({ cadence: "monthly", dayOfMonth: 31, time: "18:00" })).toBe(
    "Monthly on the 31st at 18:00",
  );
});

// ------------------------------------------------------------ CRUD + reindex

test("createRecurring writes recurring/<id>.md + an index row with a future nextRunAt", () => {
  const rec = createRecurring(db, {
    title: "Generate the monthly timesheet",
    body: "Pull the Toggl entries and prepare the report.",
    cadence: "monthly",
    dayOfMonth: 1,
    time: "09:00",
  });

  expect(existsSync(paths.recurringFile(rec.id))).toBe(true); // markdown truth
  expect(rec.paused).toBe(false);
  expect(rec.nextRunAt).toBeGreaterThan(Date.now()); // anchored at creation → never fires for the past
  expect(listRecurring(db).map((r) => r.id)).toContain(rec.id);
});

test("createRecurring is description-first like capture (derived title)", () => {
  const rec = createRecurring(db, {
    body: "Water the plants\nAll of them.",
    cadence: "daily",
    time: "08:00",
  });
  expect(rec.title).toBe("Water the plants");
});

test("updateRecurring merges into markdown and drops stray day fields on cadence change", () => {
  const rec = createRecurring(db, {
    title: "Weekly review",
    cadence: "weekly",
    dayOfWeek: 5,
    time: "16:00",
  });
  const updated = updateRecurring(db, rec.id, { cadence: "monthly", dayOfMonth: 1 });
  expect(updated?.cadence).toBe("monthly");
  expect(updated?.dayOfMonth).toBe(1);
  expect(updated?.dayOfWeek).toBeNull(); // stale weekly field dropped
  expect(readRecurring(rec.id).data.dayOfWeek).toBeUndefined();
});

test("pausing clears nextRunAt; resuming re-anchors it in the future", () => {
  const rec = createRecurring(db, { title: "Daily standup notes", cadence: "daily", time: "09:00" });
  expect(updateRecurring(db, rec.id, { paused: true })?.nextRunAt).toBeNull();
  const resumed = updateRecurring(db, rec.id, { paused: false });
  expect(resumed?.nextRunAt).toBeGreaterThan(0);
});

test("deleteRecurring removes the markdown + the row, but not the tasks it created", () => {
  const rec = createRecurring(db, { title: "Temp", cadence: "daily", time: "09:00" });
  const fired = triggerRecurring(db, rec.id);
  expect(fired).not.toBeNull();
  expect(deleteRecurring(db, rec.id)).toBe(true);
  expect(existsSync(paths.recurringFile(rec.id))).toBe(false);
  expect(getRecurring(db, rec.id)).toBeNull();
  expect(getTask(db, fired!.task.id)).not.toBeNull(); // the created task survives
  expect(deleteRecurring(db, rec.id)).toBe(false); // idempotent-ish: gone is gone
});

// ------------------------------------------------------------ triggering

/** Backdate a template's anchor so its nextRunAt is already due at `now`. */
function backdate(id: string, createdAtMs: number): void {
  const { data, body } = readRecurring(id);
  writeRecurring({ ...data, id, createdAt: new Date(createdAtMs).toISOString() }, body);
  reindexRecurring(db, id);
}

test("runRecurringTick fires due templates once and re-anchors — downtime collapses to one catch-up", () => {
  writeProject({ id: crypto.randomUUID(), name: "Acme", slug: "acme" });
  reindexProject(db, "acme");
  const rec = createRecurring(db, {
    title: "Morning triage",
    body: "Check the queue.",
    cadence: "daily",
    time: "09:00",
    project: "acme",
    priority: "P2",
  });
  const now = Date.now();
  backdate(rec.id, now - 5 * 86_400_000); // 5 missed days while "the app was off"

  const { created } = runRecurringTick(db, now);
  expect(created).toHaveLength(1); // exactly one catch-up, not five
  const task = created[0]!.task;
  expect(task.status).toBe("inbox"); // same landing spot as capture
  expect(task.title).toBe("Morning triage");
  expect(task.body).toContain("Check the queue.");
  expect(task.priority).toBe("P2");
  expect(task.projectId).not.toBeNull(); // slug resolved to the Acme project
  expect(readContext(task.id)).toContain("Created automatically by the recurring task"); // attribution

  const after = getRecurring(db, rec.id);
  expect(after?.lastTaskId).toBe(task.id);
  expect(after?.nextRunAt).toBeGreaterThan(now); // re-anchored into the future

  expect(runRecurringTick(db, now).created).toHaveLength(0); // second tick: nothing due
});

test("runRecurringTick skips paused templates even when their time has long passed", () => {
  const rec = createRecurring(db, { title: "Paused thing", cadence: "daily", time: "09:00" });
  backdate(rec.id, Date.now() - 86_400_000);
  updateRecurring(db, rec.id, { paused: true });
  expect(runRecurringTick(db, Date.now()).created).toHaveLength(0);
  expect(listTasks(db)).toHaveLength(0);
});

test("a template that isn't due yet does not fire", () => {
  createRecurring(db, { title: "Later", cadence: "daily", time: "09:00" });
  // freshly created → nextRunAt is in the future relative to now
  expect(runRecurringTick(db, Date.now()).created).toHaveLength(0);
});

test("startRecurringScheduler runs a boot catch-up pass and announces the created task", () => {
  const rec = createRecurring(db, { title: "Overnight job", cadence: "daily", time: "09:00" });
  backdate(rec.id, Date.now() - 86_400_000); // came due while the app was off
  const events: string[] = [];
  const triaged: string[] = [];
  const hub = { broadcast: (m: { name?: string }) => void events.push(m.name ?? "") };

  const handle = startRecurringScheduler(db, hub as never, {
    intervalMs: 3_600_000, // far away — only the immediate boot pass matters here
    onTaskCreated: (taskId) => triaged.push(taskId),
  });
  handle.close();

  const tasks = listTasks(db);
  expect(tasks).toHaveLength(1);
  expect(events).toContain("task:created"); // board refresh
  expect(events).toContain("recurring:triggered"); // Recurring view refresh
  expect(events).toContain("notify"); // visible attribution: Cadence did this
  expect(triaged).toEqual([tasks[0]!.id]); // handed to triage like a capture
});
