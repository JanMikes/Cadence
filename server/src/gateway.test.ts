import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, Task } from "@cadence/shared";
import { migrateDb, openDb, type Db } from "./db/client";
import { startGateway, type Gateway } from "./gateway";
import { bootstrap } from "./store/store";

let gw: Gateway;
let db: Db;
let webDir: string;
let home: string;
const terminalLaunches: Array<{ app: string; command: string }> = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-gw-home-"));
  process.env.CADENCE_HOME = home; // task.md writes land here, not the real ~/.cadence
  bootstrap();
  webDir = mkdtempSync(join(tmpdir(), "cadence-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>cadence-spa</title>");
  writeFileSync(join(webDir, "app.js"), "console.log('hi')");
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
  // Mock the terminal launcher so the test never opens a real window.
  gw = startGateway({
    port: 0,
    webDir,
    db,
    startWatcher: false,
    openTerminal: (app, command) => terminalLaunches.push({ app, command }),
  });
});

afterAll(async () => {
  await gw.stop();
  delete process.env.CADENCE_HOME;
  rmSync(webDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("GET /api/health returns ok", async () => {
  const res = await fetch(`${gw.url}/api/health`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, app: "Cadence" });
});

test("unknown /api route is a JSON 404", async () => {
  const res = await fetch(`${gw.url}/api/does-not-exist`);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: "not_found" });
});

test("POST /api/tasks captures a task; GET lists + fetches it", async () => {
  const created = await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Capture me", body: "from the api" }),
  });
  expect(created.status).toBe(201);
  const task = (await created.json()) as Task;
  expect(task).toMatchObject({ title: "Capture me", status: "inbox" });

  const list = (await fetch(`${gw.url}/api/tasks?status=inbox`).then((r) => r.json())) as Task[];
  expect(list.map((t) => t.id)).toContain(task.id);

  const one = (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task;
  expect(one.title).toBe("Capture me");
});

test("POST /api/tasks rejects an empty title", async () => {
  const res = await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   " }),
  });
  expect(res.status).toBe(400);
});

async function createViaApi(title: string): Promise<Task> {
  return fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  }).then((r) => r.json() as Promise<Task>);
}

test("PATCH /api/tasks/:id moves a task across statuses (board drag)", async () => {
  const task = await createViaApi("Drag me");
  const res = await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "ready", priority: "high" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ready", priority: "high" });

  // persisted: a fresh GET reflects it
  const after = (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task;
  expect(after.status).toBe("ready");
});

test("settings: GET defaults, PATCH preferredTerminal", async () => {
  const before = (await fetch(`${gw.url}/api/settings`).then((r) => r.json())) as {
    preferredTerminal: string;
  };
  expect(before.preferredTerminal).toBe("Terminal");

  const after = (await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferredTerminal: "iTerm" }),
  }).then((r) => r.json())) as { preferredTerminal: string };
  expect(after.preferredTerminal).toBe("iTerm");
});

test("open-terminal builds the resume command and invokes the launcher", async () => {
  const task = await createViaApi("Handoff task");
  // give the task a session row to hand off
  const session = gw.spawn.spawn({ cwd: "/tmp/handoff-cwd", taskId: task.id, role: "chat", command: ["true"] });

  await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferredTerminal: "Terminal" }),
  });

  terminalLaunches.length = 0;
  const res = await fetch(`${gw.url}/api/sessions/${session.id}/open-terminal`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; command: string };
  expect(body.command).toBe(`cd '/tmp/handoff-cwd' && claude --resume ${session.id}`);

  expect(terminalLaunches).toHaveLength(1);
  expect(terminalLaunches[0]?.command).toContain("claude --resume");
  expect(terminalLaunches[0]?.app).toBe("Terminal");

  gw.spawn.kill(session.id);
});

test("task context channel: POST appends, GET reads", async () => {
  const task = await createViaApi("With context");
  expect(await fetch(`${gw.url}/api/tasks/${task.id}/context`).then((r) => r.json())).toMatchObject({
    content: "",
  });

  const post = await fetch(`${gw.url}/api/tasks/${task.id}/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "a fresh context note" }),
  });
  expect(post.status).toBe(201);

  const ctx = (await fetch(`${gw.url}/api/tasks/${task.id}/context`).then((r) => r.json())) as {
    content: string;
  };
  expect(ctx.content).toContain("a fresh context note");
});

test("serves the built web app with SPA fallback", async () => {
  const root = await fetch(`${gw.url}/`).then((r) => r.text());
  expect(root).toContain("cadence-spa");

  const asset = await fetch(`${gw.url}/app.js`).then((r) => r.text());
  expect(asset).toContain("hi");

  // Deep links fall back to index.html (client-side routing).
  const deep = await fetch(`${gw.url}/board/abc123`).then((r) => r.text());
  expect(deep).toContain("cadence-spa");
});

test("blocks path traversal", async () => {
  const res = await fetch(`${gw.url}/../../../../etc/hosts`);
  const text = await res.text();
  expect(text).toContain("cadence-spa"); // served index.html, not /etc/hosts
  expect(text).not.toContain("localhost");
});

test("WS connect receives hello, then a broadcast", async () => {
  const ws = new WebSocket(`ws://localhost:${gw.port}/ws`);
  const received: ServerMessage[] = [];

  await new Promise<void>((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error("ws timed out")), 3000);
    ws.onmessage = (e) => {
      received.push(JSON.parse(e.data as string) as ServerMessage);
      if (received.length === 1) {
        // We are now registered in the hub (hello is sent on open) — broadcast.
        gw.broadcast({ type: "event", name: "test", payload: 42 });
      } else if (received.length === 2) {
        clearTimeout(timer);
        resolveP();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rejectP(new Error("ws error"));
    };
  });

  ws.close();
  expect(received[0]).toMatchObject({ type: "hello", app: "Cadence" });
  expect(received[1]).toEqual({ type: "event", name: "test", payload: 42 });
});
