import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityTracker } from "./activity";
import type { AgentRunner } from "./agents/triage";
import { migrateDb, openDb, type Db } from "./db/client";
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
