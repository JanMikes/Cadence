import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { listTaskSessions, taskCostUsd } from "../sessions";
import { bootstrap } from "../store/store";
import { createTask } from "../tasks";
import { WsHub } from "../ws";
import { makeRecordingRunner } from "./recording-runner";
import type { AgentRunOptions } from "./runner";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-rec-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function okResult(json: unknown, costUsd = 0): AgentResult {
  return { text: JSON.stringify(json), json, costUsd, sessionId: "claude-x", isError: false, raw: {} };
}

test("records a task-linked stage run as a done oneshot session, rolling cost into the task", async () => {
  const t = createTask(db, { title: "do a thing" });
  const seen: AgentRunOptions[] = [];
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async (opts) => {
      seen.push(opts);
      return okResult({ ok: true }, 0.0123);
    },
  });

  const result = await run({ cwd: "/tmp/proj", role: "discovery", prompt: "p", taskId: t.id });

  expect(result.json).toEqual({ ok: true });
  const rows = listTaskSessions(db, t.id);
  expect(rows).toHaveLength(1);
  const s = rows[0];
  expect(s?.kind).toBe("oneshot");
  expect(s?.role).toBe("discovery");
  expect(s?.status).toBe("done");
  expect(s?.taskId).toBe(t.id);
  expect(s?.cwd).toBe("/tmp/proj");
  expect(s?.costUsd).toBeCloseTo(0.0123, 5);
  expect(s?.startedAt).toBeGreaterThan(0);
  expect(s?.endedAt).toBeGreaterThan(0);
  // The runner assigns the session id and passes it to claude (--session-id) so the on-disk
  // transcript lands at exactly the row's transcriptPath.
  expect(seen[0]?.sessionId).toBe(s?.id ?? "");
  expect(s?.transcriptPath ?? "").toContain(`${s?.id}.jsonl`);
  // Stage cost rolls into the task total (an effort signal, §10).
  expect(taskCostUsd(db, t.id)).toBeCloseTo(0.0123, 5);
});

test("marks the session failed when the agent returns no parseable output", async () => {
  const t = createTask(db, { title: "bail" });
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async () => ({ text: "", json: null, costUsd: 0, sessionId: null, isError: false, raw: null }),
  });

  await run({ cwd: "/tmp/proj", role: "triage", prompt: "p", taskId: t.id });

  const rows = listTaskSessions(db, t.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("failed");
});

test("a run with no taskId is not recorded — it passes straight through", async () => {
  const t = createTask(db, { title: "ad-hoc" });
  let called = false;
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async () => {
      called = true;
      return okResult({ ok: true });
    },
  });

  await run({ cwd: "/tmp/proj", role: "reflector", prompt: "p" }); // no taskId

  expect(called).toBe(true);
  expect(listTaskSessions(db, t.id)).toHaveLength(0);
});
