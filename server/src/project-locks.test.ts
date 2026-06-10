import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveSession } from "@cadence/shared";
import { eq } from "drizzle-orm";
import { type Db, migrateDb, openDb } from "./db/client";
import { sessions } from "./db/schema";
import { type LockBlocker, ProjectLocks } from "./project-locks";
import { createProject } from "./projects";
import { bootstrap } from "./store/store";
import { createTask } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-locks-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("readers share; null projectId is a no-op", async () => {
  const locks = new ProjectLocks();
  const r1 = await locks.acquireRead("p1");
  const r2 = await locks.acquireRead("p1"); // resolves immediately alongside r1
  const noop = await locks.acquireRead(null);
  r1();
  r2();
  noop();
});

test("writer is exclusive: waits for readers, blocks new readers (writer preference)", async () => {
  const locks = new ProjectLocks();
  const order: string[] = [];

  const r1 = await locks.acquireRead("p1");
  const writer = locks.acquireWrite("p1").then((rel) => {
    order.push("write");
    return rel;
  });
  await tick();
  expect(order).toEqual([]); // writer waits for the active reader

  // a NEW reader queues BEHIND the waiting writer (no writer starvation)
  const lateReader = locks.acquireRead("p1").then((rel) => {
    order.push("late-read");
    return rel;
  });
  await tick();
  expect(order).toEqual([]);

  r1(); // reader drains → writer admitted first
  const wRelease = await writer;
  expect(order).toEqual(["write"]);

  wRelease(); // writer done → the queued reader runs
  const lrRelease = await lateReader;
  expect(order).toEqual(["write", "late-read"]);
  lrRelease();
});

test("two writers serialize; onQueued fires only for the one that waits", async () => {
  const locks = new ProjectLocks();
  let queued1 = 0;
  let queued2 = 0;

  const w1 = await locks.acquireWrite("p1", { onQueued: () => queued1++ });
  let w2Acquired = false;
  const w2 = locks
    .acquireWrite("p1", { onQueued: () => queued2++ })
    .then((rel) => {
      w2Acquired = true;
      return rel;
    });
  await tick();
  expect(queued1).toBe(0); // free at acquire time
  expect(queued2).toBe(1); // had to wait — surfaced exactly once
  expect(w2Acquired).toBe(false);

  w1();
  (await w2)();
  expect(w2Acquired).toBe(true);
});

test("release is idempotent (a finally + error path can both call it)", async () => {
  const locks = new ProjectLocks();
  const r = await locks.acquireRead("p1");
  r();
  r(); // second call must not corrupt the state
  const w = await locks.acquireWrite("p1"); // still acquirable
  w();
  w();
  (await locks.acquireRead("p1"))();
});

test("distinct projects never contend", async () => {
  const locks = new ProjectLocks();
  const w1 = await locks.acquireWrite("p1");
  const w2 = await locks.acquireWrite("p2"); // resolves immediately
  w1();
  w2();
});

test("survivor guard: a live in-place execution session from a previous process blocks acquisition", async () => {
  const locks = new ProjectLocks(15); // fast poll for the test
  const project = createProject(db, { name: "P", rootPath: "/tmp/p-root" });
  const survivorTask = createTask(db, { title: "Survivor" });
  const myTask = createTask(db, { title: "Mine" });

  // a session row exactly like one the recording runner leaves behind across a restart
  db.insert(sessions)
    .values({
      id: "surv-1",
      taskId: survivorTask.id,
      projectId: project.id,
      role: "implementer",
      kind: "oneshot",
      status: "running",
      cwd: "/tmp/p-root",
    })
    .run();

  const guard = { db, rootPath: "/tmp/p-root", excludeTaskId: myTask.id };
  expect(locks.isWriteBusy(project.id, guard)).toBe(true);

  let acquired = false;
  const w = locks.acquireWrite(project.id, { guard }).then((rel) => {
    acquired = true;
    return rel;
  });
  await new Promise((r) => setTimeout(r, 40));
  expect(acquired).toBe(false); // still polling — the survivor is "running"

  db.update(sessions).set({ status: "failed" }).where(eq(sessions.id, "surv-1")).run(); // watchdog ends it
  (await w)();
  expect(acquired).toBe(true);
  expect(locks.isWriteBusy(project.id, guard)).toBe(false);

  // our OWN task's sessions never block us (re-entry)
  db.update(sessions).set({ status: "running", taskId: myTask.id }).where(eq(sessions.id, "surv-1")).run();
  (await locks.acquireWrite(project.id, { guard }))();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function externalSession(over: Partial<LiveSession>): LiveSession {
  return {
    pid: 4242,
    sessionId: "ext-1",
    cwd: "/tmp/p-root",
    status: "busy",
    kind: "interactive",
    version: null,
    startedAt: null,
    updatedAt: null,
    alive: true,
    ...over,
  };
}

test("exclusive guard: a live warm chat session in the dir blocks an execution — but not read stages", async () => {
  const locks = new ProjectLocks(15, () => []);
  const project = createProject(db, { name: "P", rootPath: "/tmp/p-root" });
  const myTask = createTask(db, { title: "Mine" });
  db.insert(sessions)
    .values({
      id: "chat-1",
      taskId: myTask.id, // even a chat on OUR OWN task is a real occupant (only oneshot re-entry is excluded)
      projectId: project.id,
      role: "chat",
      kind: "warm",
      status: "running",
      cwd: "/tmp/p-root",
    })
    .run();

  // read stages and the merge probe (non-exclusive) coexist with a chat
  const shared = { db, rootPath: "/tmp/p-root" };
  (await locks.acquireRead(project.id, shared))();
  expect(locks.isWriteBusy(project.id, shared)).toBe(false);

  // an autonomous execution (exclusive) queues — visibly — until the chat ends
  const guard = { db, rootPath: "/tmp/p-root", excludeTaskId: myTask.id, exclusive: true };
  expect(locks.isWriteBusy(project.id, guard)).toBe(true);
  let acquired = false;
  let blockers: LockBlocker[] = [];
  const w = locks
    .acquireWrite(project.id, { guard, onQueued: (b) => (blockers = b) })
    .then((rel) => {
      acquired = true;
      return rel;
    });
  await sleep(40);
  expect(acquired).toBe(false);
  expect(blockers.map((b) => b.kind)).toContain("session");

  db.update(sessions).set({ status: "done" }).where(eq(sessions.id, "chat-1")).run();
  (await w)();
  expect(acquired).toBe(true);
});

test("exclusive guard: an alive claude process OUTSIDE Cadence blocks an execution until it exits", async () => {
  const oracle: LiveSession[] = [externalSession({ cwd: "/tmp/p-root/packages/web" })]; // a subdir counts
  const locks = new ProjectLocks(15, () => oracle);
  const project = createProject(db, { name: "P", rootPath: "/tmp/p-root" });
  const guard = { db, rootPath: "/tmp/p-root", exclusive: true };

  expect(locks.isWriteBusy(project.id, guard)).toBe(true);
  let acquired = false;
  let blockers: LockBlocker[] = [];
  const w = locks
    .acquireWrite(project.id, { guard, onQueued: (b) => (blockers = b) })
    .then((rel) => {
      acquired = true;
      return rel;
    });
  await sleep(40);
  expect(acquired).toBe(false);
  expect(blockers.map((b) => b.kind)).toContain("external");

  oracle.length = 0; // the session exits → its oracle file disappears
  (await w)();
  expect(acquired).toBe(true);

  // never block on: a dead pid, a session elsewhere, a path that merely shares a
  // prefix, or one of OUR OWN spawns (its DB row already speaks for it)
  db.insert(sessions)
    .values({ id: "ours-1", projectId: project.id, role: "implementer", kind: "oneshot", status: "done", cwd: "/tmp/p-root" })
    .run();
  oracle.push(
    externalSession({ alive: false }),
    externalSession({ pid: 1, cwd: "/tmp/other" }),
    externalSession({ pid: 2, cwd: "/tmp/p-root-sibling" }),
    externalSession({ pid: 3, sessionId: "ours-1" }),
  );
  expect(locks.isWriteBusy(project.id, guard)).toBe(false);
});

test("tryAcquireWrite claims the slot without waiting — and a held merge serializes with writers", async () => {
  const locks = new ProjectLocks(15, () => []);

  const merge = locks.tryAcquireWrite("p1");
  expect(merge).not.toBeNull();

  // an execution queues behind the merge; a second merge refuses while anything holds/awaits
  let acquired = false;
  const w = locks.acquireWrite("p1").then((rel) => {
    acquired = true;
    return rel;
  });
  await tick();
  expect(acquired).toBe(false);
  expect(locks.tryAcquireWrite("p1")).toBeNull();

  (merge as () => void)();
  (await w)();
  expect(acquired).toBe(true);

  // a surviving execution session refuses the merge slot too (no probe-then-act race)
  const project = createProject(db, { name: "P", rootPath: "/tmp/p-root" });
  const survivorTask = createTask(db, { title: "Survivor" });
  db.insert(sessions)
    .values({
      id: "surv-m",
      taskId: survivorTask.id,
      projectId: project.id,
      role: "delivery",
      kind: "oneshot",
      status: "running",
      cwd: "/tmp/p-root",
    })
    .run();
  expect(locks.tryAcquireWrite(project.id, { db, rootPath: "/tmp/p-root" })).toBeNull();
});
