import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Db, migrateDb, openDb } from "../db/client";
import { sessions } from "../db/schema";
import type { LivenessProbe } from "../liveness";
import { listTaskSessions } from "../sessions";
import { bootstrap } from "../store/store";
import { createTask } from "../tasks";
import { WsHub } from "../ws";
import { makeRecordingRunner } from "./recording-runner";
import { findLiveStage, StageConflictError } from "./stage-guard";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-guard-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function seedRun(
  taskId: string,
  over: Partial<typeof sessions.$inferInsert> = {},
): string {
  const id = crypto.randomUUID();
  db.insert(sessions)
    .values({
      id,
      taskId,
      role: "discovery",
      kind: "oneshot",
      status: "running",
      cwd: "/tmp/proj",
      costUsd: 0,
      startedAt: Date.now(),
      ...over,
    })
    .run();
  return id;
}

// Honest-liveness unit tests live in ../liveness.test.ts; here we only need probes.
const zombieProbe: LivenessProbe = {
  alive: () => true, // defunct passes kill(0)!
  proc: () => ({ stat: "Z+", etimeSec: 5, command: "(claude)" }),
  now: Date.now,
};

// --- findLiveStage ---------------------------------------------------------

test("a genuinely alive run is found and NOT finalized", () => {
  const t = createTask(db, { title: "x" });
  const id = seedRun(t.id, { pid: process.pid }); // real probes: alive, non-zombie
  const live = findLiveStage(db, t.id, "discovery");
  expect(live?.id).toBe(id);
  expect(listTaskSessions(db, t.id)[0]?.status).toBe("running");
});

test("defunct-zombie and dead-pid rows are finalized as failed and unblock the stage", () => {
  const t = createTask(db, { title: "x" });
  const zombie = seedRun(t.id, { pid: 4242 });
  const dead = seedRun(t.id, { pid: 4243 });
  expect(findLiveStage(db, t.id, "discovery", zombieProbe)).toBeNull();
  for (const id of [zombie, dead]) {
    const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeGreaterThan(0);
  }
});

test("a young pid-less row (insert→onSpawn window) counts as live; an old one is stale", () => {
  const t = createTask(db, { title: "x" });
  const young = seedRun(t.id, { pid: null });
  expect(findLiveStage(db, t.id, "discovery")?.id).toBe(young);

  const t2 = createTask(db, { title: "y" });
  seedRun(t2.id, { pid: null, startedAt: Date.now() - 60_000 }); // never got a process
  expect(findLiveStage(db, t2.id, "discovery")).toBeNull();
});

test("the guard is scoped per (task, role): other roles and other tasks don't conflict", () => {
  const t = createTask(db, { title: "x" });
  seedRun(t.id, { pid: process.pid, role: "triage" });
  expect(findLiveStage(db, t.id, "discovery")).toBeNull();
  const other = createTask(db, { title: "z" });
  expect(findLiveStage(db, other.id, "triage")).toBeNull();
});

// --- recording-runner integration -----------------------------------------

const ok = { text: '{"ok":true}', json: { ok: true }, costUsd: 0, sessionId: null, isError: false, raw: {} };

test("recording runner refuses to spawn a second live run of the same stage", async () => {
  const t = createTask(db, { title: "dedupe" });
  seedRun(t.id, { pid: process.pid }); // an honestly-alive discovery
  let called = false;
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async () => {
      called = true;
      return ok;
    },
  });

  expect(run({ cwd: "/tmp/p", role: "discovery", prompt: "p", taskId: t.id })).rejects.toThrow(
    StageConflictError,
  );
  expect(called).toBe(false);
  expect(listTaskSessions(db, t.id)).toHaveLength(1); // no second row inserted
});

test("two concurrent runs of the same stage → exactly one spawn", async () => {
  const t = createTask(db, { title: "race" });
  let calls = 0;
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30)); // hold the stage "live" briefly
      return ok;
    },
  });

  const results = await Promise.allSettled([
    run({ cwd: "/tmp/p", role: "discovery", prompt: "p", taskId: t.id }),
    run({ cwd: "/tmp/p", role: "discovery", prompt: "p", taskId: t.id }),
  ]);

  expect(calls).toBe(1);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(StageConflictError);
});

test("a finished run never blocks the next one", async () => {
  const t = createTask(db, { title: "sequential" });
  const run = makeRecordingRunner({ db, hub: new WsHub(), base: async () => ok });

  await run({ cwd: "/tmp/p", role: "discovery", prompt: "p", taskId: t.id });
  await run({ cwd: "/tmp/p", role: "discovery", prompt: "p", taskId: t.id });

  const rows = listTaskSessions(db, t.id);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.status === "done")).toBe(true);
});

test("a stale zombie row from a previous gateway life is finalized and the retry proceeds", async () => {
  const t = createTask(db, { title: "heal-bait" });
  const zombie = seedRun(t.id, { pid: null, startedAt: Date.now() - 120_000 });
  const run = makeRecordingRunner({ db, hub: new WsHub(), base: async () => ok });

  await run({ cwd: "/tmp/p", role: "discovery", prompt: "p", taskId: t.id });

  const rows = listTaskSessions(db, t.id);
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id === zombie)?.status).toBe("failed");
  expect(rows.find((r) => r.id !== zombie)?.status).toBe("done");
});
