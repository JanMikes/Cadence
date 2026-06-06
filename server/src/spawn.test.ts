import type { ClaudeEvent } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import { getSession, SpawnManager } from "./sessions";
import { openSession } from "./spawn";
import { WsHub } from "./ws";

// Run the deterministic mock via the bun binary (no PATH assumptions, no real claude).
const MOCK_CMD = [process.execPath, join(import.meta.dir, "testing", "mock-claude.ts")];

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-spawn-"));
  process.env.CADENCE_HOME = home;
  db = openDb(":memory:");
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function waitUntil(pred: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test("openSession parses stream-json events (system/init … result)", async () => {
  const events: ClaudeEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 5000);
    const handle = openSession({
      sessionId: "t1",
      cwd: home,
      command: MOCK_CMD,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "result") handle.close();
      },
      onClose: () => {
        clearTimeout(timer);
        resolve();
      },
      onError: reject,
    });
    handle.send("hello");
  });

  const init = events.find((e) => e.type === "system");
  expect(init?.subtype).toBe("init");
  expect(events.some((e) => e.type === "result")).toBe(true);
});

test("SpawnManager records a session row, runs on init, records cost on result", async () => {
  const mgr = new SpawnManager(db, new WsHub());

  const session = mgr.spawn({ cwd: home, taskId: null, role: "chat", command: MOCK_CMD });
  expect(session.status).toBe("spawning");
  expect(session.kind).toBe("warm");
  expect(getSession(db, session.id)?.cwd).toBe(home);
  expect(getSession(db, session.id)?.transcriptPath).toContain(session.id);

  // system/init → running
  expect(await waitUntil(() => getSession(db, session.id)?.status === "running")).toBe(true);

  // a turn → result → cost recorded
  expect(mgr.send(session.id, "ping")).toBe(true);
  expect(await waitUntil(() => (getSession(db, session.id)?.costUsd ?? 0) > 0)).toBe(true);
  expect(getSession(db, session.id)?.costUsd).toBeCloseTo(0.0123, 4);

  // close → done
  mgr.close(session.id);
  expect(await waitUntil(() => getSession(db, session.id)?.status === "done")).toBe(true);
  expect(mgr.liveIds()).not.toContain(session.id);
});
