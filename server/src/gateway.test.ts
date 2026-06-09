import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** Per-test hook: lets a test make the mock Implementer touch files / sleep in its cwd. */
let implementerSideEffect: ((opts: { cwd: string }) => Promise<void> | void) | null = null;

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
        await implementerSideEffect?.(opts);
        json = { ok: true }; // the implementer only checks for errors, not JSON shape
      } else if (opts.role === "verifier") {
        json = { passed: true, checks: [{ name: "tests", passed: true }], criteria: [], issues: [] };
      } else if (opts.role === "delivery") {
        json = { summary: "Implemented and verified.", branch: null, prUrl: null };
      } else if (opts.role === "worktree_check") {
        json = {
          verdict: "blockers",
          summary: "Needs a per-checkout .env.",
          blockers: [{ title: ".env not committed", detail: "", severity: "high" }],
          recommendation: "Add an .env.example.",
        };
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

test("POST /api/tasks rejects a capture with neither description nor title", async () => {
  const res = await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   ", body: "  " }),
  });
  expect(res.status).toBe(400);
});

test("POST /api/tasks accepts a description-only capture and derives a provisional title", async () => {
  const created = await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Fix the flaky login test\nIt fails on CI only." }),
  });
  expect(created.status).toBe(201);
  const task = (await created.json()) as Task;
  expect(task.title).toBe("Fix the flaky login test"); // first line of the description
  expect(task.body).toContain("It fails on CI only.");
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

  // the planner runs in the background — wait for the task to PARK in plan_review
  // (not just for plan.md: approving mid-flip would now 409, §6.1.f)
  let status = "";
  for (let i = 0; i < 80 && status !== "plan_review"; i++) {
    await new Promise((r) => setTimeout(r, 20));
    status = ((await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task).status;
  }
  expect(status).toBe("plan_review");
  const plan = (await fetch(`${gw.url}/api/tasks/${task.id}/plan`).then((r) => r.json())) as {
    steps: Array<{ title: string }>;
    approved: boolean;
  };
  expect(plan.steps.length).toBe(2);
  expect(plan.approved).toBe(false);

  const approved = (await fetch(`${gw.url}/api/tasks/${task.id}/plan/approve`, { method: "POST" }).then(
    (r) => r.json(),
  )) as { approved: boolean; steps: Array<{ title: string }> };
  expect(approved.approved).toBe(true);
  expect(approved.steps.length).toBe(2); // steps preserved through approval
});

test("double plan-approve starts ONE execution chain; the second POST gets 409 (§6.1.f)", async () => {
  // A real repo-backed project so the implementer actually runs (a project-less task bails).
  const repo = mkdtempSync(join(tmpdir(), "cadence-gw-dup-"));
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# x\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);

  let implementerRuns = 0;
  implementerSideEffect = async () => {
    implementerRuns += 1;
    await new Promise((r) => setTimeout(r, 250)); // keep the chain visibly active
  };
  try {
    const project = (await fetch(`${gw.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Dup Approve Repo", rootPath: repo, worktreesEnabled: true }),
    }).then((r) => r.json())) as { slug: string };
    const task = await createViaApi("Approve twice");
    await fetch(`${gw.url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: project.slug, status: "ready" }),
    });
    await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });
    let status = "";
    for (let i = 0; i < 80 && status !== "plan_review"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = ((await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task).status;
    }
    expect(status).toBe("plan_review");

    const first = await fetch(`${gw.url}/api/tasks/${task.id}/plan/approve`, { method: "POST" });
    expect(first.status).toBe(200);

    // wait until the chain is actually running (the implementer holds it open ~250ms)
    let active: Array<{ taskId: string }> = [];
    for (let i = 0; i < 100 && !active.some((a) => a.taskId === task.id); i++) {
      await new Promise((r) => setTimeout(r, 10));
      active = (await fetch(`${gw.url}/api/activity`).then((r) => r.json())) as typeof active;
    }
    expect(active.some((a) => a.taskId === task.id)).toBe(true);

    const second = await fetch(`${gw.url}/api/tasks/${task.id}/plan/approve`, { method: "POST" });
    expect(second.status).toBe(409); // already running — no second chain

    // let the chain finish, then prove only ONE implementer ever ran
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const now = (await fetch(`${gw.url}/api/activity`).then((r) => r.json())) as typeof active;
      if (!now.some((a) => a.taskId === task.id)) break;
    }
    expect(implementerRuns).toBe(1);
  } finally {
    implementerSideEffect = null;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("PLAY parks the task in Plan review, and /api/attention surfaces it", async () => {
  const task = await createViaApi("Awaiting plan approval");
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "ready" }),
  });
  await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });

  // the planner runs in the background, then the task parks in plan_review (a distinct,
  // visible "waiting on you" state — not silently stuck in "In progress")
  let status = "";
  for (let i = 0; i < 80 && status !== "plan_review"; i++) {
    await new Promise((r) => setTimeout(r, 20));
    status = ((await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task).status;
  }
  expect(status).toBe("plan_review");

  // the unified "needs you" feed surfaces it as a plan_approval item
  const attention = (await fetch(`${gw.url}/api/attention`).then((r) => r.json())) as {
    count: number;
    items: Array<{ kind: string; taskId?: string; summary: string; actionLabel: string }>;
  };
  const item = attention.items.find((x) => x.taskId === task.id);
  expect(item?.kind).toBe("plan_approval");
  expect(item?.actionLabel).toBe("Approve plan");
  expect(item?.summary).toContain("2 step");
});

test("execution slice (worktrees opted in): PLAY → plan → approve → Implementer → Verifier → review", async () => {
  // a real git repo + an isolated worktree base for this task
  const repo = mkdtempSync(join(tmpdir(), "cadence-gw-repo-"));
  const wtBase = mkdtempSync(join(tmpdir(), "cadence-gw-wt-"));
  process.env.CADENCE_WORKTREES = wtBase;
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  const head = () =>
    Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, stdout: "pipe" })
      .stdout.toString()
      .trim();
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
      // worktree isolation is opt-in per project (default off → in-place execution)
      body: JSON.stringify({ name: "GW Repo", rootPath: repo, worktreesEnabled: true }),
    }).then((r) => r.json())) as { slug: string };

    const task = await createViaApi("Implement via gateway");
    await fetch(`${gw.url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: project.slug, status: "ready" }),
    });
    await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });

    // wait for the Planner (background) to park the task in plan_review, then approve
    // (approving mid-planner would now 409 — §6.1.f)
    let planStatus = "";
    for (let i = 0; i < 80 && planStatus !== "plan_review"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      planStatus = ((await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task).status;
    }
    expect(planStatus).toBe("plan_review");
    const plan = (await fetch(`${gw.url}/api/tasks/${task.id}/plan`).then((r) => r.json())) as {
      steps: unknown[];
    };
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

    // the run stayed isolated: a worktree exists under the base, and the user's
    // checkout never left main
    expect(readdirSync(wtBase).length).toBeGreaterThan(0);
    expect(head()).toBe("main");

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

test("in-place execution slice (worktrees off — the default): branch in the main repo, base restored, serialized", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cadence-gw-inplace-"));
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  const head = () =>
    Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, stdout: "pipe" })
      .stdout.toString()
      .trim();
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# x\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);
  // the user's untracked secret must never get committed by a delivery
  writeFileSync(join(repo, ".env"), "SECRET=1\n");

  // track execution concurrency: with worktrees off, implementations must serialize
  let active = 0;
  let maxActive = 0;
  implementerSideEffect = async ({ cwd }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    writeFileSync(join(cwd, "feature.txt"), "made by the implementer\n");
    await new Promise((r) => setTimeout(r, 80));
    active -= 1;
  };

  try {
    const project = (await fetch(`${gw.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GW InPlace", rootPath: repo }), // default: worktrees OFF
    }).then((r) => r.json())) as { slug: string };

    // two tasks in the same project, approved back-to-back → the second queues
    const ids: string[] = [];
    for (const title of ["First in-place change", "Second in-place change"]) {
      const task = await createViaApi(title);
      ids.push(task.id);
      await fetch(`${gw.url}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: project.slug, status: "ready" }),
      });
      await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });
      let plan = { steps: [] as unknown[] };
      for (let i = 0; i < 50 && plan.steps.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
        plan = (await fetch(`${gw.url}/api/tasks/${task.id}/plan`).then((r) => r.json())) as typeof plan;
      }
      expect(plan.steps.length).toBe(2);
    }
    await Promise.all(
      ids.map((id) => fetch(`${gw.url}/api/tasks/${id}/plan/approve`, { method: "POST" })),
    );

    // both chains complete → review; they never overlapped in the working dir
    for (const id of ids) {
      let status = "";
      for (let i = 0; i < 150 && status !== "review"; i++) {
        await new Promise((r) => setTimeout(r, 20));
        status = ((await fetch(`${gw.url}/api/tasks/${id}`).then((r) => r.json())) as Task).status;
      }
      expect(status).toBe("review");
    }
    expect(maxActive).toBe(1); // one implementation per project at a time

    // the repo is back on main, clean of task files, .env untouched + uncommitted
    expect(head()).toBe("main");
    expect(existsSync(join(repo, "feature.txt"))).toBe(false);
    expect(existsSync(join(repo, ".env"))).toBe(true);

    // each task's diff shows its branch work (committed on the in-place branch)
    const diff = (await fetch(`${gw.url}/api/tasks/${ids[0]}/diff`).then((r) => r.json())) as {
      mode: string;
      branch: string | null;
      diff: string;
    };
    expect(diff.branch).toContain("cadence/");
    expect(diff.diff).toContain("feature.txt");

    // merge the first → done; its work lands on main and the branch is tidied away
    const merge = (await fetch(`${gw.url}/api/tasks/${ids[0]}/review/merge`, { method: "POST" }).then(
      (r) => r.json(),
    )) as { merged: boolean; task: { status: string } };
    expect(merge.merged).toBe(true);
    expect(merge.task.status).toBe("done");
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    const gitEnv = Bun.spawnSync(["git", "log", "--all", "--name-only", "--pretty=format:"], {
      cwd: repo,
      stdout: "pipe",
    }).stdout.toString();
    expect(gitEnv).not.toContain(".env"); // the secret never entered history
  } finally {
    implementerSideEffect = null;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("POST /api/projects/:slug/worktree-check runs the readiness check and persists the verdict", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cadence-gw-check-"));
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
      body: JSON.stringify({ name: "GW Check", rootPath: repo }),
    }).then((r) => r.json())) as { slug: string };

    const res = await fetch(`${gw.url}/api/projects/${project.slug}/worktree-check`, { method: "POST" });
    expect(res.status).toBe(202);

    // fire-and-forget: the verdict lands on the project shortly after
    type CheckShape = { verdict?: string; blockers?: unknown[] } | null;
    let check: CheckShape = null;
    for (let i = 0; i < 50 && !check; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const p = (await fetch(`${gw.url}/api/projects/${project.slug}`).then((r) => r.json())) as {
        worktreeCheck: CheckShape;
        worktreesEnabled: boolean;
      };
      check = p.worktreeCheck;
      if (check) expect(p.worktreesEnabled).toBe(false); // propose, don't impose
    }
    expect(check?.verdict).toBe("blockers");
    expect(check?.blockers).toHaveLength(1);

    // no rootPath → a clear 409, not a doomed background run
    const pathless = (await fetch(`${gw.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No Root" }),
    }).then((r) => r.json())) as { slug: string };
    const bad = await fetch(`${gw.url}/api/projects/${pathless.slug}/worktree-check`, { method: "POST" });
    expect(bad.status).toBe(409);
  } finally {
    rmSync(repo, { recursive: true, force: true });
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

test("learned feed: GET entries, then DELETE reverts one", async () => {
  await fetch(`${gw.url}/api/memory/learned`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "# learned\n\n- first lesson\n- second lesson\n" }),
  });
  const entries = (await fetch(`${gw.url}/api/learned`).then((r) => r.json())) as Array<{
    index: number;
    text: string;
  }>;
  expect(entries.map((e) => e.text)).toEqual(["first lesson", "second lesson"]);

  const del = await fetch(`${gw.url}/api/learned/0`, { method: "DELETE" });
  expect(del.status).toBe(200);
  const after = (await fetch(`${gw.url}/api/learned`).then((r) => r.json())) as Array<{ text: string }>;
  expect(after.map((e) => e.text)).toEqual(["second lesson"]);
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

test("settings: a claudeBinPath PATCH reaches the spawn env (CADENCE_CLAUDE_BIN)", async () => {
  const prev = process.env.CADENCE_CLAUDE_BIN;
  try {
    const set = (await fetch(`${gw.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claudeBinPath: "/custom/bin/claude" }),
    }).then((r) => r.json())) as { claudeBinPath?: string };
    expect(set.claudeBinPath).toBe("/custom/bin/claude");
    // spawn.ts / agents/runner.ts / import.ts read exactly `process.env.CADENCE_CLAUDE_BIN ?? "claude"`
    expect(process.env.CADENCE_CLAUDE_BIN ?? "claude").toBe("/custom/bin/claude");

    // clearing it (empty string) unsets the override → spawns fall back to "claude"
    const cleared = (await fetch(`${gw.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claudeBinPath: "" }),
    }).then((r) => r.json())) as { claudeBinPath?: string };
    expect(cleared.claudeBinPath).toBeUndefined();
    expect(process.env.CADENCE_CLAUDE_BIN ?? "claude").toBe("claude");
  } finally {
    if (prev === undefined) delete process.env.CADENCE_CLAUDE_BIN;
    else process.env.CADENCE_CLAUDE_BIN = prev;
  }
});

test("open-terminal builds the resume command and invokes the launcher", async () => {
  const task = await createViaApi("Handoff task");
  // give the task a session row to hand off — the cwd must exist (the route refuses
  // to hand off into a deleted working dir)
  const handoffCwd = mkdtempSync(join(tmpdir(), "handoff-cwd-"));
  const session = gw.spawn.spawn({ cwd: handoffCwd, taskId: task.id, role: "chat", command: ["true"] });

  await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferredTerminal: "Terminal" }),
  });

  terminalLaunches.length = 0;
  // `true` exits immediately — wait for the close hook so the session isn't "live"
  // (a live session demands mode=takeover; that path is tested separately).
  for (let i = 0; i < 100 && gw.spawn.liveIds().includes(session.id); i++) await Bun.sleep(10);
  const res = await fetch(`${gw.url}/api/sessions/${session.id}/open-terminal`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; command: string };
  expect(body.command).toBe(`cd '${handoffCwd}' && claude --resume ${session.id}`);

  expect(terminalLaunches).toHaveLength(1);
  expect(terminalLaunches[0]?.command).toContain("claude --resume");
  expect(terminalLaunches[0]?.app).toBe("Terminal");

  gw.spawn.kill(session.id);
  rmSync(handoffCwd, { recursive: true, force: true });
});

test("open-terminal refuses a live session without takeover, then takes over cleanly", async () => {
  const task = await createViaApi("Takeover task");
  const cwd = mkdtempSync(join(tmpdir(), "takeover-cwd-"));
  // a long-running fake claude process — stays alive until stdin EOF (like a warm claude)
  const session = gw.spawn.spawn({ cwd, taskId: task.id, role: "chat", command: ["bash", "-c", "read -r line"] });

  terminalLaunches.length = 0;
  const refused = await fetch(`${gw.url}/api/sessions/${session.id}/open-terminal`, { method: "POST" });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("session_running");
  expect(terminalLaunches).toHaveLength(0); // nothing opened — no frozen fork

  const res = await fetch(`${gw.url}/api/sessions/${session.id}/open-terminal?mode=takeover`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; tookOver?: boolean };
  expect(body.tookOver).toBe(true);
  expect(terminalLaunches).toHaveLength(1); // resumed only after the process stopped
  const after = (await fetch(`${gw.url}/api/sessions/${session.id}`).then((r) => r.json())) as {
    isLive: boolean;
    status: string;
  };
  expect(after.isLive).toBe(false);
  rmSync(cwd, { recursive: true, force: true });
});

test("transcript route returns [] (not 404) when nothing is on disk yet", async () => {
  const task = await createViaApi("Transcript pending");
  const cwd = mkdtempSync(join(tmpdir(), "transcript-cwd-"));
  const session = gw.spawn.spawn({ cwd, taskId: task.id, role: "chat", command: ["true"] });
  const res = await fetch(`${gw.url}/api/sessions/${session.id}/transcript`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
  rmSync(cwd, { recursive: true, force: true });
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

test("CADENCE_WEB_DIR relocates the served web assets (compiled-sidecar path)", async () => {
  // With no opts.webDir, the gateway must fall back to process.env.CADENCE_WEB_DIR —
  // this is how the Tauri sidecar points at web assets shipped as bundle resources.
  const altWeb = mkdtempSync(join(tmpdir(), "cadence-altweb-"));
  writeFileSync(join(altWeb, "index.html"), "<!doctype html><title>relocated-spa</title>");
  const altHome = mkdtempSync(join(tmpdir(), "cadence-altweb-home-"));
  const altDb = openDb(join(altHome, "cadence.db"));
  migrateDb(altDb);
  const prev = process.env.CADENCE_WEB_DIR;
  process.env.CADENCE_WEB_DIR = altWeb;
  let g: Gateway | undefined;
  try {
    g = startGateway({ port: 0, db: altDb, startWatcher: false }); // deliberately no webDir
    const root = await fetch(`${g.url}/`).then((r) => r.text());
    expect(root).toContain("relocated-spa");
  } finally {
    await g?.stop();
    if (prev === undefined) delete process.env.CADENCE_WEB_DIR;
    else process.env.CADENCE_WEB_DIR = prev;
    rmSync(altWeb, { recursive: true, force: true });
    rmSync(altHome, { recursive: true, force: true });
  }
});

test("writes $CADENCE_HOME/runtime.json on startup, removes it on graceful stop", async () => {
  // Self-contained home so the app-smoke / Tauri supervisor can find the ephemeral port.
  const rtHome = mkdtempSync(join(tmpdir(), "cadence-rt-home-"));
  const rtDb = openDb(join(rtHome, "cadence.db"));
  migrateDb(rtDb);
  const prevHome = process.env.CADENCE_HOME;
  process.env.CADENCE_HOME = rtHome;
  const runtimeFile = join(rtHome, "runtime.json");
  let g: Gateway | undefined;
  try {
    g = startGateway({ port: 0, db: rtDb, startWatcher: false });
    expect(existsSync(runtimeFile)).toBe(true);
    const info = JSON.parse(readFileSync(runtimeFile, "utf8")) as {
      port: number;
      url: string;
      pid: number;
    };
    expect(info.port).toBe(g.port); // the actual bound (ephemeral) port
    expect(info.url).toBe(g.url);
    expect(info.pid).toBe(process.pid);

    await g.stop();
    g = undefined;
    expect(existsSync(runtimeFile)).toBe(false); // graceful stop removes the descriptor
  } finally {
    await g?.stop();
    if (prevHome === undefined) delete process.env.CADENCE_HOME;
    else process.env.CADENCE_HOME = prevHome;
    rmSync(rtHome, { recursive: true, force: true });
  }
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
