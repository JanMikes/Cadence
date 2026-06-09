import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityTracker } from "./activity";
import type { AgentRunner } from "./agents/triage";
import { migrateDb, openDb, type Db } from "./db/client";
import { sessions } from "./db/schema";
import { healStuckTasks } from "./heal";
import { bootstrap } from "./store/store";
import { createTask, getTask, updateTask } from "./tasks";
import { WsHub } from "./ws";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-heal-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function runnerFor(byRole: Record<string, object>): AgentRunner {
  return async (opts) => {
    const json = byRole[opts.role ?? ""] ?? {};
    return { text: JSON.stringify(json), json, costUsd: 0, sessionId: "m", isError: false, raw: {} } as AgentResult;
  };
}

test("healStuckTasks re-runs discovery on a stranded refining task → resolved", async () => {
  const t = createTask(db, { title: "stuck in refining" });
  updateTask(db, t.id, { status: "refining" }); // simulate a previous crashed/stuck run

  const healed = await healStuckTasks({
    db,
    runAgent: runnerFor({ discovery: { sufficiency: "ok", spec: "A clear spec", unknowns: [] } }),
    activity: new ActivityTracker(() => {}),
    hub: new WsHub(),
  });

  expect(healed).toBe(1);
  expect(getTask(db, t.id)?.status).toBe("ready");
});

test("self-heal never re-strands: discovery unknowns + questioner garbage → Needs-Feedback", async () => {
  const t = createTask(db, { title: "needs questions but the questioner drifts" });
  updateTask(db, t.id, { status: "refining" });

  await healStuckTasks({
    db,
    runAgent: runnerFor({
      discovery: { sufficiency: "ok", spec: "S", unknowns: ["which db?"] },
      questioner: { notQuestions: true }, // no `questions` array → must not strand in refining
    }),
    activity: new ActivityTracker(() => {}),
    hub: new WsHub(),
  });

  expect(getTask(db, t.id)?.status).toBe("needs_feedback");
});

/** Seed a finished discovery attempt `ageMs` in the past (counts toward the budget). */
function seedAttempt(taskId: string, ageMs: number): void {
  db.insert(sessions)
    .values({
      id: crypto.randomUUID(),
      taskId,
      role: "discovery",
      kind: "oneshot",
      status: "failed",
      cwd: "/tmp/proj",
      costUsd: 0,
      startedAt: Date.now() - ageMs,
      endedAt: Date.now() - ageMs,
    })
    .run();
}

test("circuit breaker: 3 recent attempts → no spawn, Needs-Feedback + notification (§6.1.c)", async () => {
  const t = createTask(db, { title: "doom loop bait" });
  updateTask(db, t.id, { status: "refining" });
  for (let i = 0; i < 3; i++) seedAttempt(t.id, 60_000 * (i + 1));

  let spawns = 0;
  const broadcasts: Array<{ name: string; payload?: unknown }> = [];
  const hub = { broadcast: (m: { name: string; payload?: unknown }) => broadcasts.push(m) } as unknown as WsHub;

  const healed = await healStuckTasks({
    db,
    runAgent: async (opts) => {
      spawns += 1;
      return runnerFor({ discovery: { sufficiency: "ok", spec: "S", unknowns: [] } })(opts);
    },
    activity: new ActivityTracker(() => {}),
    hub,
  });

  expect(spawns).toBe(0); // the whole point: no fourth agent, no silent money
  expect(healed).toBe(0);
  expect(getTask(db, t.id)?.status).toBe("needs_feedback");
  const notify = broadcasts.find((b) => b.name === "notify");
  expect((notify?.payload as { kind?: string })?.kind).toBe("needs_feedback");
});

test("circuit breaker: attempts older than the 24h window don't count", async () => {
  const t = createTask(db, { title: "stale history is fine" });
  updateTask(db, t.id, { status: "refining" });
  for (let i = 0; i < 3; i++) seedAttempt(t.id, 25 * 60 * 60 * 1000 + i * 1000); // 25h ago

  const healed = await healStuckTasks({
    db,
    runAgent: runnerFor({ discovery: { sufficiency: "ok", spec: "S", unknowns: [] } }),
    activity: new ActivityTracker(() => {}),
    hub: new WsHub(),
  });

  expect(healed).toBe(1);
  expect(getTask(db, t.id)?.status).toBe("ready");
});

test("circuit breaker: under budget (2 recent attempts) still heals", async () => {
  const t = createTask(db, { title: "two strikes" });
  updateTask(db, t.id, { status: "refining" });
  seedAttempt(t.id, 60_000);
  seedAttempt(t.id, 120_000);

  const healed = await healStuckTasks({
    db,
    runAgent: runnerFor({ discovery: { sufficiency: "ok", spec: "S", unknowns: [] } }),
    activity: new ActivityTracker(() => {}),
    hub: new WsHub(),
  });

  expect(healed).toBe(1);
  expect(getTask(db, t.id)?.status).toBe("ready");
});
