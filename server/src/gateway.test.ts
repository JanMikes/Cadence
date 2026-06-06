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
      } else if (opts.role === "planner") {
        json = { steps: [{ title: "Wire the endpoint", files: ["api.ts"] }, { title: "Add a test" }] };
      } else if (opts.role === "implementer") {
        json = { ok: true }; // the implementer only checks for errors, not JSON shape
      } else if (opts.role === "verifier") {
        json = { passed: true, checks: [{ name: "tests", passed: true }], criteria: [], issues: [] };
      } else if (opts.role === "delivery") {
        json = { summary: "Implemented and verified.", branch: null, prUrl: null };
      } else if (opts.role === "reflector") {
        json = { lessons: [{ scope: "global", note: "Jan bumps priorities up by one" }] };
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

test("POST /api/tasks/:id/play requires Ready, then opens the implementing phase", async () => {
  const task = await createViaApi("Play me");
  // not Ready yet → 409
  const tooEarly = await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });
  expect(tooEarly.status).toBe(409);

  // move it to Ready (inbox → ready is a valid manual move)
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "ready" }),
  });
  const played = await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });
  expect(played.status).toBe(200);
  expect(await played.json()).toMatchObject({ status: "implementing" });

  // the transition is recorded on the timeline
  const timeline = (await fetch(`${gw.url}/api/tasks/${task.id}/timeline`).then((r) => r.json())) as Array<{
    type: string;
    payload: { from: string | null; to: string };
  }>;
  expect(timeline.some((e) => e.payload?.to === "implementing")).toBe(true);
});

test("PLAY runs the Planner (mock) → an approvable plan that POST approve confirms", async () => {
  const task = await createViaApi("Plan via play");
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "ready" }),
  });
  await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });

  // the planner runs in the background — poll until plan.md has steps
  let plan = { steps: [] as Array<{ title: string }>, approved: false };
  for (let i = 0; i < 50 && plan.steps.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
    plan = (await fetch(`${gw.url}/api/tasks/${task.id}/plan`).then((r) => r.json())) as typeof plan;
  }
  expect(plan.steps.length).toBe(2);
  expect(plan.approved).toBe(false);

  const approved = (await fetch(`${gw.url}/api/tasks/${task.id}/plan/approve`, { method: "POST" }).then(
    (r) => r.json(),
  )) as { approved: boolean; steps: Array<{ title: string }> };
  expect(approved.approved).toBe(true);
  expect(approved.steps.length).toBe(2); // steps preserved through approval
});

test("execution slice: PLAY → plan → approve → Implementer → Verifier → review", async () => {
  // a real git repo + an isolated worktree base for this task
  const repo = mkdtempSync(join(tmpdir(), "cadence-gw-repo-"));
  const wtBase = mkdtempSync(join(tmpdir(), "cadence-gw-wt-"));
  process.env.CADENCE_WORKTREES = wtBase;
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# x\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);

  try {
    const project = (await fetch(`${gw.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GW Repo", rootPath: repo }),
    }).then((r) => r.json())) as { slug: string };

    const task = await createViaApi("Implement via gateway");
    await fetch(`${gw.url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: project.slug, status: "ready" }),
    });
    await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });

    // wait for the Planner (background) to produce steps, then approve
    let plan = { steps: [] as unknown[] };
    for (let i = 0; i < 50 && plan.steps.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      plan = (await fetch(`${gw.url}/api/tasks/${task.id}/plan`).then((r) => r.json())) as typeof plan;
    }
    expect(plan.steps.length).toBe(2);
    await fetch(`${gw.url}/api/tasks/${task.id}/plan/approve`, { method: "POST" });

    // Implementer (worktree) → Verifier (pass) run in the background → review
    let status = "";
    for (let i = 0; i < 80 && status !== "review"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = ((await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task).status;
    }
    expect(status).toBe("review");

    // the verify report is persisted + served
    const verify = (await fetch(`${gw.url}/api/tasks/${task.id}/verify`).then((r) => r.json())) as {
      passed: boolean;
    };
    expect(verify.passed).toBe(true);

    // Delivery ran (chained after a passing verify) → a summary is served
    let delivery = { summary: "", mode: "" };
    for (let i = 0; i < 50 && !delivery.summary; i++) {
      await new Promise((r) => setTimeout(r, 20));
      delivery = (await fetch(`${gw.url}/api/tasks/${task.id}/delivery`).then((r) => r.json())) as typeof delivery;
    }
    expect(delivery.mode).toBe("branch_summary");
    expect(delivery.summary.length).toBeGreaterThan(0);

    // Review screen: the diff endpoint serves the task's changes shape
    const diff = (await fetch(`${gw.url}/api/tasks/${task.id}/diff`).then((r) => r.json())) as {
      mode: string;
      branch: string | null;
    };
    expect(diff.mode).toBe("branch_summary");
    expect(diff.branch).toContain("cadence/");

    // merge → done
    const merge = (await fetch(`${gw.url}/api/tasks/${task.id}/review/merge`, { method: "POST" }).then(
      (r) => r.json(),
    )) as { merged: boolean; task: { status: string } };
    expect(merge.merged).toBe(true);
    expect(merge.task.status).toBe("done");
  } finally {
    delete process.env.CADENCE_WORKTREES;
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  }
});

test("review/request-changes sends a task in review back to implementing with a note", async () => {
  const task = await createViaApi("Needs another pass");
  // get it to review via valid manual moves (each transition is allowed)
  for (const status of ["ready", "implementing", "verifying", "review"]) {
    await fetch(`${gw.url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }
  const res = await fetch(`${gw.url}/api/tasks/${task.id}/review/request-changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "please add tests" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()) as { status: string }).toMatchObject({ status: "implementing" });

  // the note landed on the context channel
  const ctx = (await fetch(`${gw.url}/api/tasks/${task.id}/context`).then((r) => r.json())) as {
    content: string;
  };
  expect(ctx.content).toContain("please add tests");
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

test("GET /api/digest proposes a plan; POST /api/digest/commit locks it in", async () => {
  const a = await createViaApi("Digest A");
  const b = await createViaApi("Digest B");

  const proposed = (await fetch(`${gw.url}/api/digest`).then((r) => r.json())) as {
    status: string;
    picks: Array<{ taskId: string }>;
  };
  expect(proposed.status).toBe("planning");
  expect(proposed.picks.length).toBeGreaterThanOrEqual(2);

  const committed = (await fetch(`${gw.url}/api/digest/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ picks: [b.id, a.id], goal: "Focus on B" }),
  }).then((r) => r.json())) as { status: string; goal: string; picks: Array<{ taskId: string }> };
  expect(committed.status).toBe("committed");
  expect(committed.goal).toBe("Focus on B");
  expect(committed.picks.map((p) => p.taskId)).toEqual([b.id, a.id]);

  // a fresh GET returns the committed plan, not a new proposal
  const after = (await fetch(`${gw.url}/api/digest`).then((r) => r.json())) as { status: string };
  expect(after.status).toBe("committed");
});

test("POST /api/digest/commit rejects a non-array picks payload", async () => {
  const res = await fetch(`${gw.url}/api/digest/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "no picks" }),
  });
  expect(res.status).toBe(400);
});

test("POST /api/digest/recap closes the day with progress + a positive note", async () => {
  const a = await createViaApi("Recap A");
  const b = await createViaApi("Recap B");
  await fetch(`${gw.url}/api/digest/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ picks: [a.id, b.id] }),
  });
  // ship one pick through the lifecycle (inbox → ready → done)
  for (const status of ["ready", "done"]) {
    await fetch(`${gw.url}/api/tasks/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }
  const recapped = (await fetch(`${gw.url}/api/digest/recap`, { method: "POST" }).then((r) =>
    r.json(),
  )) as { status: string; progress: { done: number; total: number }; recap: { note: string } };
  expect(recapped.status).toBe("recapped");
  expect(recapped.progress).toEqual({ done: 1, total: 2 });
  expect(recapped.recap.note.length).toBeGreaterThan(0);
});

test("approvals: a parked canUseTool request lists, then resolve frees the agent", async () => {
  // park a request directly on the registry (as the SDK's canUseTool would)
  const decision = gw.approvals.request({ toolName: "Bash", input: { command: "ls" } }, { id: "ga1" });

  const pending = (await fetch(`${gw.url}/api/approvals`).then((r) => r.json())) as Array<{
    id: string;
    toolName: string;
  }>;
  expect(pending.some((a) => a.id === "ga1" && a.toolName === "Bash")).toBe(true);

  const res = await fetch(`${gw.url}/api/approvals/ga1/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allow: true }),
  });
  expect(res.status).toBe(200);
  await expect(decision).resolves.toEqual({ allow: true, reason: undefined });

  // resolving an unknown id is a 404
  const missing = await fetch(`${gw.url}/api/approvals/nope/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allow: true }),
  });
  expect(missing.status).toBe(404);
});

test("fleets: create with ordered members, list, get, patch", async () => {
  const created = (await fetch(`${gw.url}/api/fleets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Platform", projects: ["api", "web"], systemPrompt: "sync" }),
  }).then((r) => r.json())) as { slug: string; projects: string[] };
  expect(created.slug).toBe("platform");
  expect(created.projects).toEqual(["api", "web"]);

  const list = (await fetch(`${gw.url}/api/fleets`).then((r) => r.json())) as Array<{ slug: string }>;
  expect(list.map((f) => f.slug)).toContain("platform");

  const patched = (await fetch(`${gw.url}/api/fleets/platform`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects: ["web", "api", "infra"] }),
  }).then((r) => r.json())) as { projects: string[] };
  expect(patched.projects).toEqual(["web", "api", "infra"]);
});

test("POST /api/tasks/:id/fleet-run bails cleanly for a non-fleet task", async () => {
  const task = await createViaApi("Not on a fleet");
  const outcome = (await fetch(`${gw.url}/api/tasks/${task.id}/fleet-run`, { method: "POST" }).then((r) =>
    r.json(),
  )) as { ran: boolean; reason?: string };
  expect(outcome.ran).toBe(false);
  expect(outcome.reason).toContain("not assigned");
});

test("dependencies: add (blockedBy/blocks), reject a cycle, remove", async () => {
  const a = await createViaApi("Task A");
  const b = await createViaApi("Task B");
  // B blocks A
  const added = await fetch(`${gw.url}/api/tasks/${a.id}/deps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blockerId: b.id }),
  });
  expect(added.status).toBe(200);
  const deps = (await added.json()) as { blockedBy: Array<{ id: string }> };
  expect(deps.blockedBy.map((t) => t.id)).toEqual([b.id]);
  // reverse query: B blocks A
  const bDeps = (await fetch(`${gw.url}/api/tasks/${b.id}/deps`).then((r) => r.json())) as {
    blocks: Array<{ id: string }>;
  };
  expect(bDeps.blocks.map((t) => t.id)).toEqual([a.id]);

  // a cycle (A blocks B) is a 409
  const cyc = await fetch(`${gw.url}/api/tasks/${b.id}/deps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blockerId: a.id }),
  });
  expect(cyc.status).toBe(409);

  // remove
  const removed = (await fetch(`${gw.url}/api/tasks/${a.id}/deps/${b.id}`, { method: "DELETE" }).then(
    (r) => r.json(),
  )) as { blockedBy: unknown[] };
  expect(removed.blockedBy).toHaveLength(0);
});

test("subtasks: PATCH parentTask, then GET subtasks lists the children", async () => {
  const parent = await createViaApi("Parent task");
  const child = await createViaApi("Child task");
  await fetch(`${gw.url}/api/tasks/${child.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentTask: parent.id }),
  });
  const subs = (await fetch(`${gw.url}/api/tasks/${parent.id}/subtasks`).then((r) => r.json())) as Array<{
    id: string;
  }>;
  expect(subs.map((t) => t.id)).toContain(child.id);
});

test("GET /api/sweep returns a proactive findings report", async () => {
  const report = (await fetch(`${gw.url}/api/sweep`).then((r) => r.json())) as {
    ranAt: number;
    findings: unknown[];
  };
  expect(typeof report.ranAt).toBe("number");
  expect(Array.isArray(report.findings)).toBe(true);
});

test("GET /api/proposals returns proactive nudges (array)", async () => {
  const proposals = await fetch(`${gw.url}/api/proposals`).then((r) => r.json());
  expect(Array.isArray(proposals)).toBe(true);
});

test("GET /api/self-monitor returns provenance + verify + rollovers", async () => {
  const m = (await fetch(`${gw.url}/api/self-monitor`).then((r) => r.json())) as {
    provenance: { confirmed: number };
    verify: { passRate: number | null };
    rollovers: number;
    staleTasks: number;
  };
  expect(typeof m.provenance.confirmed).toBe("number");
  expect("passRate" in m.verify).toBe(true);
  expect(typeof m.rollovers).toBe("number");
  expect(typeof m.staleTasks).toBe("number");
});

test("GET /api/analytics returns cost/throughput/status aggregates", async () => {
  await createViaApi("Analytics task");
  const a = (await fetch(`${gw.url}/api/analytics`).then((r) => r.json())) as {
    totalTasks: number;
    byProject: unknown[];
    throughput: unknown[];
    byStatus: Record<string, number>;
  };
  expect(a.totalTasks).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(a.byProject)).toBe(true);
  expect(a.throughput).toHaveLength(14);
  expect(typeof a.byStatus).toBe("object");
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

test("saved searches: create, list, delete via the API", async () => {
  const created = (await fetch(`${gw.url}/api/searches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Blocked", query: "status:blocked" }),
  }).then((r) => r.json())) as { id: string; name: string };
  expect(created.name).toBe("Blocked");

  const list = (await fetch(`${gw.url}/api/searches`).then((r) => r.json())) as Array<{ id: string }>;
  expect(list.map((s) => s.id)).toContain(created.id);

  const del = await fetch(`${gw.url}/api/searches/${created.id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  const after = (await fetch(`${gw.url}/api/searches`).then((r) => r.json())) as unknown[];
  expect(after).toHaveLength(0);
});

test("GET /api/search/transcripts returns [] for an empty query", async () => {
  expect(await fetch(`${gw.url}/api/search/transcripts?q=`).then((r) => r.json())).toEqual([]);
  // a non-empty query is valid even with no matching transcripts on disk
  const hits = await fetch(`${gw.url}/api/search/transcripts?q=elasticsearch`).then((r) => r.json());
  expect(Array.isArray(hits)).toBe(true);
});

test("reflect: a correction signal → the Reflector writes a learned memory note", async () => {
  // create + override a suggestion (a correction signal)
  const s = (await fetch(`${gw.url}/api/suggestions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entityType: "task", entityId: "rt1", field: "priority", value: "P2" }),
  }).then((r) => r.json())) as { id: string };
  await fetch(`${gw.url}/api/suggestions/${s.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "override", value: "P1" }),
  });

  const outcome = (await fetch(`${gw.url}/api/reflect`, { method: "POST" }).then((r) => r.json())) as {
    ran: boolean;
    lessons: number;
  };
  expect(outcome.ran).toBe(true);
  expect(outcome.lessons).toBeGreaterThanOrEqual(1);

  const memory = (await fetch(`${gw.url}/api/memory`).then((r) => r.json())) as Array<{
    name: string;
    content: string;
  }>;
  expect(memory.find((m) => m.name === "learned")?.content).toContain("bumps priorities");
});

test("memory: PUT a global memory file, GET it back", async () => {
  const put = await fetch(`${gw.url}/api/memory/communication`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Signal over noise. Czech/English fine." }),
  });
  expect(put.status).toBe(200);
  const list = (await fetch(`${gw.url}/api/memory`).then((r) => r.json())) as Array<{
    name: string;
    content: string;
  }>;
  const file = list.find((f) => f.name === "communication");
  expect(file?.content).toContain("Signal over noise");
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
