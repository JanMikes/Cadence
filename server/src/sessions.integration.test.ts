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

test("posting to an unknown session is a 409", async () => {
  const res = await fetch(`${gw.url}/api/sessions/not-a-session/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  expect(res.status).toBe(409);
});
