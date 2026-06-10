import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createProject } from "../projects";
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

test("appends the project's per-agent prompt addition to a stage run (§6.3.b project layer)", async () => {
  const p = createProject(db, {
    name: "Acme",
    rootPath: "/tmp/acme",
    agentPrompts: { discovery: "Prefer bun APIs over node shims.", planner: "Plan in small steps." },
  });
  const t = createTask(db, { title: "do a thing", project: p.slug });
  const seen: AgentRunOptions[] = [];
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async (opts) => {
      seen.push(opts);
      return okResult({ ok: true });
    },
  });

  // A role with an addition: composed onto the rendered global prompt, put together.
  await run({ cwd: "/tmp/acme", role: "discovery", prompt: "rendered stage prompt", taskId: t.id });
  expect(seen[0]?.prompt).toBe(
    "rendered stage prompt\n\nPROJECT INSTRUCTIONS (Acme):\nPrefer bun APIs over node shims.",
  );

  // A role without one: the prompt is untouched.
  await run({ cwd: "/tmp/acme", role: "verifier", prompt: "verify it", taskId: t.id });
  expect(seen[1]?.prompt).toBe("verify it");
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

test("records the child pid and forwards live events to the hub as session:event", async () => {
  const t = createTask(db, { title: "live stream" });
  const broadcasts: Array<{ name: string; payload?: unknown }> = [];
  const hub = {
    broadcast: (msg: { name: string; payload?: unknown }) => broadcasts.push(msg),
  } as unknown as WsHub;

  const run = makeRecordingRunner({
    db,
    hub,
    base: async (opts) => {
      // a real runner reports the pid, then streams events while working
      opts.onSpawn?.(4242);
      opts.onEvent?.({ type: "system", subtype: "init" });
      opts.onEvent?.({ type: "assistant", message: { role: "assistant", content: [] } });
      return okResult({ ok: true }, 0.01);
    },
  });

  await run({ cwd: "/tmp/proj", role: "implementer", prompt: "p", taskId: t.id });

  const s = listTaskSessions(db, t.id)[0];
  expect(s?.pid).toBe(4242); // liveness/Stop/Kill now work for pipeline runs
  const events = broadcasts.filter((b) => b.name === "session:event");
  expect(events).toHaveLength(2);
  expect((events[0]?.payload as { sessionId: string }).sessionId).toBe(s?.id ?? "");
});
