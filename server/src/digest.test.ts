import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import {
  commitDigest,
  computeStreak,
  generateNote,
  getDigest,
  pickRationale,
  proposePlan,
  recapDigest,
  todayString,
} from "./digest";
import { readDigest } from "./store/store";
import { bootstrap } from "./store/store";
import { createTask, updateTask } from "./tasks";

let db: Db;
let home: string;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-digest-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("todayString is the server-local date", () => {
  expect(todayString(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("pickRationale leads with the deadline, then priority", () => {
  expect(pickRationale({ deadline: NOW - DAY, priority: "P3", status: "ready" } as never, NOW)).toContain(
    "Overdue",
  );
  expect(pickRationale({ deadline: NOW + DAY, priority: "P0", status: "ready" } as never, NOW)).toBe(
    "Due tomorrow · P0",
  );
  expect(pickRationale({ deadline: null, priority: null, status: "ready" } as never, NOW)).toBe(
    "Ready to start",
  );
});

test("proposePlan ranks open tasks deadline-first and excludes done/cancelled", () => {
  const far = createTask(db, { title: "Far" });
  const overdue = createTask(db, { title: "Overdue" });
  const finished = createTask(db, { title: "Finished" });
  updateTask(db, far.id, { deadline: NOW + 30 * DAY, priority: "P0" });
  updateTask(db, overdue.id, { deadline: NOW - DAY, priority: "P3" });
  updateTask(db, finished.id, { status: "ready" });
  updateTask(db, finished.id, { status: "done" });

  const plan = proposePlan(db, todayString(NOW), NOW);
  expect(plan.status).toBe("planning");
  const ids = plan.picks.map((p) => p.taskId);
  expect(ids).not.toContain(finished.id); // closed → excluded
  expect(ids.indexOf(overdue.id)).toBeLessThan(ids.indexOf(far.id)); // overdue first
  expect(plan.picks[0]?.order).toBe(0);
});

test("commitDigest persists an ordered plan + goal that getDigest reads back", () => {
  const a = createTask(db, { title: "Alpha" });
  const b = createTask(db, { title: "Beta" });
  const date = todayString(NOW);

  const committed = commitDigest(
    db,
    { date, picks: [b.id, a.id], goal: "Ship Beta", constraints: "2 meetings" },
    NOW,
  );
  expect(committed.status).toBe("committed");
  expect(committed.picks.map((p) => p.taskId)).toEqual([b.id, a.id]); // order preserved
  expect(committed.goal).toBe("Ship Beta");

  // persisted to disk
  expect(readDigest(date)?.status).toBe("committed");
  // getDigest now returns the committed plan, not a fresh proposal
  const fetched = getDigest(db, NOW, date);
  expect(fetched.status).toBe("committed");
  expect(fetched.picks[0]?.title).toBe("Beta");
});

test("getDigest reports live goal progress (done picks / total)", () => {
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  const date = todayString(NOW);
  commitDigest(db, { date, picks: [a.id, b.id] }, NOW);

  expect(getDigest(db, NOW, date).progress).toEqual({ done: 0, total: 2 });
  // ship one pick (status → done via the lifecycle)
  updateTask(db, a.id, { status: "ready" });
  updateTask(db, a.id, { status: "done" });
  expect(getDigest(db, NOW, date).progress).toEqual({ done: 1, total: 2 });
});

test("generateNote is positive in every branch, never guilt", () => {
  expect(generateNote(["X", "Y"], 2, 2, true)).toContain("Strong day");
  expect(generateNote([], 0, 3, false)).toContain("Fresh start");
  expect(generateNote(["X"], 1, 3, false)).toContain("Solid progress");
  expect(generateNote([], 0, 0, false)).toContain("capture a few tasks");
});

test("recapDigest tallies shipped/rolled-over, freezes counts, and builds a streak", () => {
  const a = createTask(db, { title: "Shipme" });
  const b = createTask(db, { title: "Rollme" });
  const date = todayString(NOW);
  commitDigest(db, { date, picks: [a.id, b.id] }, NOW);
  updateTask(db, a.id, { status: "ready" });
  updateTask(db, a.id, { status: "done" });

  const recapped = recapDigest(db, NOW, date);
  expect(recapped.status).toBe("recapped");
  expect(recapped.recap?.done).toBe(1);
  expect(recapped.recap?.shipped).toEqual(["Shipme"]);
  expect(recapped.recap?.rolledOver).toEqual([b.id]);
  expect(recapped.recap?.met).toBe(false);

  // a fully-met prior day builds a streak of 1 (today isn't met → not penalized)
  const yest = todayString(NOW - 86_400_000);
  const c = createTask(db, { title: "Done yesterday" });
  commitDigest(db, { date: yest, picks: [c.id] }, NOW - 86_400_000);
  updateTask(db, c.id, { status: "ready" });
  updateTask(db, c.id, { status: "done" });
  recapDigest(db, NOW - 86_400_000, yest);
  expect(computeStreak(NOW)).toBe(1);
});
