import type { ServerMessage } from "@cadence/shared";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import { startGateway, type Gateway } from "./gateway";
import { getSession } from "./sessions";
import { bootstrap } from "./store/store";

// Live send→stream→WS path, end-to-end, against the deterministic mock claude
// (no real model). Proves: POST a follow-up → the warm session replies → the
// gateway broadcasts the event to connected web clients.
const MOCK_CMD = [process.execPath, join(import.meta.dir, "testing", "mock-claude.ts")];

let gw: Gateway;
let db: Db;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-sess-int-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
  gw = startGateway({ port: 0, db, startWatcher: false });
});

afterAll(async () => {
  await gw.stop();
  await new Promise((r) => setTimeout(r, 250)); // let killed sessions finish their close event
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function collectEvents(predicate: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${gw.port}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("ws timed out"));
    }, timeoutMs);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as ServerMessage;
      if (predicate(m)) {
        clearTimeout(timer);
        ws.close();
        resolve(m);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
}

test("follow-up message streams a reply back over WS (session:event)", async () => {
  // Spawn a mock warm session in the task cwd.
  const session = gw.spawn.spawn({ cwd: home, role: "chat", command: MOCK_CMD });

  // Listen for the assistant/result event carrying our echoed text, THEN send.
  const got = collectEvents((m) => {
    if (m.type !== "event" || m.name !== "session:event") return false;
    const p = m.payload as { sessionId?: string; event?: { type?: string; result?: string } };
    return p.sessionId === session.id && p.event?.type === "result" && p.event.result === "echo: ping-1";
  });

  // small delay so the WS client is registered before we drive a turn
  await new Promise((r) => setTimeout(r, 150));
  const res = await fetch(`${gw.url}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ping-1" }),
  });
  expect(res.status).toBe(200);

  const event = await got;
  const payload = event.type === "event" ? (event.payload as { event?: { result?: string } }) : {};
  expect(payload.event?.result).toBe("echo: ping-1");

  // the result event was folded into the session row's cost
  expect(getSession(db, session.id)?.costUsd ?? 0).toBeGreaterThan(0);
});

test("moving a task to needs_feedback broadcasts a notify event over WS", async () => {
  const task = await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Answer me" }),
  }).then((r) => r.json() as Promise<{ id: string }>);

  const got = collectEvents(
    (m) => m.type === "event" && m.name === "notify",
  );
  await new Promise((r) => setTimeout(r, 150)); // ensure the WS client is registered

  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "needs_feedback" }),
  });

  const event = await got;
  const payload = event.type === "event" ? (event.payload as { kind?: string; taskId?: string }) : {};
  expect(payload.kind).toBe("needs_feedback");
  expect(payload.taskId).toBe(task.id);
});

test("posting to an unknown session is a 409", async () => {
  const res = await fetch(`${gw.url}/api/sessions/not-a-session/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  expect(res.status).toBe(409);
});

test("session detail exposes liveness; assigning a task organizes it", async () => {
  const session = gw.spawn.spawn({ cwd: home, role: "chat", command: MOCK_CMD });

  // detail reports it as live right after spawn
  const detail = (await fetch(`${gw.url}/api/sessions/${session.id}`).then((r) => r.json())) as {
    id: string;
    isLive: boolean;
    taskId: string | null;
  };
  expect(detail.id).toBe(session.id);
  expect(detail.isLive).toBe(true);

  // make a task and assign the session to it
  const task = (await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Owns a session" }),
  }).then((r) => r.json())) as { id: string };

  const patched = (await fetch(`${gw.url}/api/sessions/${session.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: task.id }),
  }).then((r) => r.json())) as { taskId: string | null };
  expect(patched.taskId).toBe(task.id);

  // the task's session list now includes it
  const taskSessions = (await fetch(`${gw.url}/api/tasks/${task.id}/sessions`).then((r) =>
    r.json(),
  )) as Array<{ id: string }>;
  expect(taskSessions.some((s) => s.id === session.id)).toBe(true);

  // an unknown task is rejected (400)
  const bad = await fetch(`${gw.url}/api/sessions/${session.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "nope" }),
  });
  expect(bad.status).toBe(400);

  gw.spawn.kill(session.id);
});

test("stop on an unknown session is a 404; delete removes the row", async () => {
  const res = await fetch(`${gw.url}/api/sessions/not-a-session/stop`, { method: "POST" });
  expect(res.status).toBe(404);

  const session = gw.spawn.spawn({ cwd: home, role: "chat", command: MOCK_CMD });
  const del = (await fetch(`${gw.url}/api/sessions/${session.id}`, { method: "DELETE" }).then((r) =>
    r.json(),
  )) as { deleted: boolean };
  expect(del.deleted).toBe(true);
  expect(getSession(db, session.id)).toBeNull();
});
