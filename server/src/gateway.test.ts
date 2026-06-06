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
    enrich: async (cwd) => ({ description: `mock description for ${cwd}`, stack: "bun" }),
    // Role-aware mock so the autonomy pipeline runs a realistic refinement loop.
    runAgent: async (opts) => {
      let json: object;
      if (opts.role === "discovery") {
        json = { sufficiency: "ok", spec: "Spec body", unknowns: ["which auth provider?"] };
      } else if (opts.role === "questioner") {
        json = { questions: [{ id: "q1", rank: 1, type: "text", text: "Which auth provider?" }] };
      } else {
        json = { sufficiency: "ok", restatement: "auto", priority: "P2", labels: ["auto"] }; // triage
      }
      return { text: JSON.stringify(json), json, costUsd: 0, sessionId: "mock", isError: false, raw: {} };
    },
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

test("PATCH rejects an illegal lifecycle transition (409) and leaves the task untouched", async () => {
  const task = await createViaApi("Cannot reopen anywhere");
  // park it: inbox → cancelled is legal
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "cancelled" }),
  });
  // cancelled → verifying is NOT legal (cancelled reopens only to inbox/ready)
  const res = await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "verifying" }),
  });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string; from: string; allowed: string[] };
  expect(body.error).toBe("conflict");
  expect(body.from).toBe("cancelled");
  expect(body.allowed).toContain("ready");

  // unchanged
  const after = (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task;
  expect(after.status).toBe("cancelled");
});

test("GET /api/tasks/:id/timeline records status changes", async () => {
  const task = await createViaApi("Track my history");
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "triaged" }),
  });
  const timeline = (await fetch(`${gw.url}/api/tasks/${task.id}/timeline`).then((r) => r.json())) as Array<{
    type: string;
    payload: { from: string | null; to: string };
  }>;
  const statusEvents = timeline.filter((e) => e.type === "status_change");
  // capture (→ inbox) + the triaged transition
  expect(statusEvents.length).toBeGreaterThanOrEqual(2);
  expect(statusEvents[0]?.payload).toMatchObject({ from: null, to: "inbox" });
  expect(statusEvents.at(-1)?.payload).toMatchObject({ from: "inbox", to: "triaged" });
});

test("project import: candidates list, enrich (mocked), and create selected", async () => {
  const candidates = await fetch(`${gw.url}/api/import/candidates`).then((r) => r.json());
  expect(Array.isArray(candidates)).toBe(true);

  const enriched = (await fetch(`${gw.url}/api/import/enrich`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp/some-repo" }),
  }).then((r) => r.json())) as { description: string; stack: string };
  expect(enriched.description).toContain("mock description");
  expect(enriched.stack).toBe("bun");

  const created = (await fetch(`${gw.url}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selections: [{ cwd: "/tmp/imported-repo", name: "Imported Repo" }] }),
  }).then((r) => r.json())) as Array<{ rootPath: string; name: string }>;
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ rootPath: "/tmp/imported-repo", name: "Imported Repo" });
});

test("autonomy on: capturing runs the triage→discovery pipeline in the background", async () => {
  // default is off — a captured task stays in Inbox
  const offTask = await createViaApi("stays in inbox");
  await new Promise((r) => setTimeout(r, 120));
  expect(
    ((await fetch(`${gw.url}/api/tasks/${offTask.id}`).then((r) => r.json())) as { status: string })
      .status,
  ).toBe("inbox");

  // turn autonomy on, then capture → triage → discovery (mock returns ok/no-unknowns → Ready)
  await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ global: { autonomy: true } }),
  });
  try {
    const task = await createViaApi("refine me automatically");
    const statusNow = async () =>
      ((await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as { status: string })
        .status;
    let status = "";
    for (let i = 0; i < 100; i++) {
      status = await statusNow();
      if (status === "needs_feedback") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // triage → discovery (unknowns) → questioner → Needs-Feedback with a Q&A card
    expect(status).toBe("needs_feedback");
    const qa = (await fetch(`${gw.url}/api/tasks/${task.id}/qa`).then((r) => r.json())) as {
      questions: Array<{ id: string }>;
    };
    expect(qa.questions.map((q) => q.id)).toContain("q1");

    // answering the question advances it to Ready
    await fetch(`${gw.url}/api/tasks/${task.id}/qa/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { q1: "OAuth" } }),
    });
    expect(await statusNow()).toBe("ready");
  } finally {
    await fetch(`${gw.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ global: { autonomy: false } }),
    });
  }
});

test("POST /api/tasks/:id/refine runs discovery (mock) and produces an outcome", async () => {
  const task = await createViaApi("Add a feature flag system");
  const outcome = (await fetch(`${gw.url}/api/tasks/${task.id}/refine`, { method: "POST" }).then((r) =>
    r.json(),
  )) as { ran: boolean; status: string };
  expect(outcome.ran).toBe(true);
  // the role-aware mock's discovery returns unknowns → stays in Refining
  expect(outcome.status).toBe("refining");
});

test("GET /api/tasks?sort=urgency orders overdue/due-soon ahead of far-off", async () => {
  const far = await createViaApi("Far off");
  const overdue = await createViaApi("Overdue");
  const dayMs = 86_400_000;
  await fetch(`${gw.url}/api/tasks/${far.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deadline: Date.now() + 30 * dayMs, priority: "P0" }),
  });
  await fetch(`${gw.url}/api/tasks/${overdue.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deadline: Date.now() - dayMs, priority: "P3" }),
  });
  const sorted = (await fetch(`${gw.url}/api/tasks?sort=urgency`).then((r) => r.json())) as Array<{
    id: string;
    urgencyTier: string;
  }>;
  const ids = sorted.map((t) => t.id);
  // overdue (low priority) still outranks the far-off urgent task
  expect(ids.indexOf(overdue.id)).toBeLessThan(ids.indexOf(far.id));
  expect(sorted.find((t) => t.id === overdue.id)?.urgencyTier).toBe("overdue");
});

test("GET /api/search finds a task by body text (FTS)", async () => {
  await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Indexing work", body: "implement the elasticsearch reindexer" }),
  });
  const hits = (await fetch(`${gw.url}/api/search?q=elasticsearch`).then((r) => r.json())) as Array<{
    title: string;
  }>;
  expect(hits.some((h) => h.title === "Indexing work")).toBe(true);
  expect(await fetch(`${gw.url}/api/search?q=`).then((r) => r.json())).toEqual([]);
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
