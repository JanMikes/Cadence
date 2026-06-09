import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Db, migrateDb, openDb } from "./db/client";
import { sessions } from "./db/schema";
import { ProjectLocks } from "./project-locks";
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
