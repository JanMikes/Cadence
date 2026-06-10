import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, Task } from "@cadence/shared";
import { eq } from "drizzle-orm";
import { migrateDb, openDb, type Db } from "./db/client";
import { sessions, tasks as tasksTable } from "./db/schema";
import { startGateway, type Gateway } from "./gateway";
import { bootstrap, writeDelivery, writeQa } from "./store/store";

let gw: Gateway;
let db: Db;
let webDir: string;
let home: string;
const terminalLaunches: Array<{ app: string; command: string }> = [];
const publishedReviews: Array<{ verdict: string; comments: number }> = [];
const postedReplies: number[] = [];
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
    prAuthor: () => "octocat", // deterministic review-direction input (no real gh/glab)
    reviewApi: () => ({
      fetchMeta: () => ({
        title: "Fix login",
        author: "octocat",
        state: "open",
        baseBranch: "main",
        headBranch: "fix/login",
        url: "https://github.com/acme/widget/pull/42",
        body: "desc",
        ciStatus: "success",
      }),
      fetchDiff: () => "diff --git a/x b/x\n+1\n",
      fetchThreads: () => [],
      publishReview: (_ref, verdict, _summary, comments) => {
        publishedReviews.push({ verdict, comments: comments.length });
        return { url: "https://github.com/acme/widget/pull/42#review-1" };
      },
      replyToThread: () => {
        postedReplies.push(1);
      },
      resolveThread: () => true,
    }),
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
      } else if (opts.prompt.includes("AMBIGUOUS-PROJECT")) {
        // triage abstaining on the project (not confident → candidates, no guess)
        json = {
          sufficiency: "ok",
          restatement: "auto",
          projectSlug: null,
          projectCandidates: ["pick-me-a"],
          priority: "P2",
        };
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

test("POST /api/tasks honors explicit capture chips (project/priority/deadline/permission/parent/blockedBy)", async () => {
  const project = await fetch(`${gw.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Chip Capture", rootPath: "/tmp/chip-capture" }),
  }).then((r) => r.json() as Promise<{ id: string; slug: string }>);
  const blocker = await createViaApi("The blocker");
  const parent = await createViaApi("The parent");

  const deadline = Date.parse("2026-08-01T00:00:00Z");
  const created = await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Fully specified capture",
      project: project.slug,
      priority: "P1",
      deadline,
      permissionMode: "manual",
      parentTask: parent.id,
      blockedBy: [blocker.id],
    }),
  });
  expect(created.status).toBe(201);
  const task = (await created.json()) as Task;
  expect(task).toMatchObject({ priority: "P1", permissionMode: "manual", projectId: project.id });
  expect(task.deadline).toBe(deadline);
  expect(task.parentTaskId).toBe(parent.id);

  const deps = (await fetch(`${gw.url}/api/tasks/${task.id}/deps`).then((r) => r.json())) as {
    blockedBy: Task[];
  };
  expect(deps.blockedBy.map((t) => t.id)).toEqual([blocker.id]);
  const subtasks = (await fetch(`${gw.url}/api/tasks/${parent.id}/subtasks`).then((r) =>
    r.json(),
  )) as Task[];
  expect(subtasks.map((t) => t.id)).toContain(task.id);
});

test("POST /api/tasks: explicit project null = pinned 'no project'", async () => {
  const created = await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Unassigned on purpose", project: null }),
  });
  expect(created.status).toBe(201);
  expect(((await created.json()) as Task).projectId).toBeNull();
});

test("POST /api/tasks validates the capture chips (400s)", async () => {
  const post = (body: object) =>
    fetch(`${gw.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "bad capture", ...body }),
    });
  expect((await post({ priority: "P9" })).status).toBe(400);
  expect((await post({ permissionMode: "yolo" })).status).toBe(400);
  expect((await post({ deadline: "tomorrow" })).status).toBe(400);
  expect((await post({ parentTask: "no-such-task" })).status).toBe(400);
  expect((await post({ blockedBy: ["no-such-task"] })).status).toBe(400);
  expect((await post({ project: "" })).status).toBe(400);
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

test("autonomy on: an unconfident triage asks 'which project?' and answering resumes the pipeline", async () => {
  await fetch(`${gw.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Pick Me A", rootPath: "/tmp/pick-me-a" }),
  });
  await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ global: { autonomy: true } }),
  });
  try {
    const task = await createViaApi("AMBIGUOUS-PROJECT tweak the build cache");
    const getTaskNow = async () =>
      (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as {
        status: string;
        projectId: string | null;
      };
    const getQa = async () =>
      (await fetch(`${gw.url}/api/tasks/${task.id}/qa`).then((r) => r.json())) as {
        questions: Array<{ id: string; options?: string[] }>;
      };

    // triage abstains → Needs-Feedback with the project card (no guess applied)
    for (let i = 0; i < 100; i++) {
      if ((await getTaskNow()).status === "needs_feedback") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await getTaskNow()).status).toBe("needs_feedback");
    expect((await getTaskNow()).projectId).toBeNull();
    const card = (await getQa()).questions.find((q) => q.id === "triage-project");
    expect(card?.options?.[0]).toBe("pick-me-a"); // the candidate leads
    expect(card?.options).toContain("None");

    // answering assigns the project and resumes: discovery → questioner → q1 card
    const answered = await fetch(`${gw.url}/api/tasks/${task.id}/qa/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { "triage-project": "pick-me-a" } }),
    });
    expect(answered.status).toBe(200);
    for (let i = 0; i < 100; i++) {
      if ((await getQa()).questions.some((q) => q.id === "q1")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await getQa()).questions.map((q) => q.id)).toEqual(["q1"]); // project card consumed
    expect((await getTaskNow()).projectId).toBeTruthy();
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

  // the work-product gate requires the run to leave real changes behind
  implementerSideEffect = ({ cwd }) => {
    writeFileSync(join(cwd, "feature.txt"), "made by the implementer\n");
  };

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
    implementerSideEffect = null;
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
        worktreeCheckRun: { status: string } | null;
        worktreesEnabled: boolean;
      };
      check = p.worktreeCheck;
      if (check) {
        expect(p.worktreesEnabled).toBe(false); // propose, don't impose
        expect(p.worktreeCheckRun).toBeNull(); // the verdict cleared the persisted lifecycle
      }
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

test("POST /api/sessions/clear-finished drops finished agent rows, keeps live + warm (§6.1.g)", async () => {
  const seed = (over: Partial<typeof sessions.$inferInsert> = {}): string => {
    const id = crypto.randomUUID();
    db.insert(sessions)
      .values({
        id,
        role: "discovery",
        kind: "oneshot",
        status: "done",
        cwd: "/tmp",
        costUsd: 0,
        startedAt: Date.now(),
        ...over,
      })
      .run();
    return id;
  };
  const done = seed({ status: "done" });
  const failed = seed({ status: "failed" });
  const killed = seed({ status: "killed" });
  const liveOneshot = seed({ status: "running" });
  const warmDone = seed({ kind: "warm", role: "chat", status: "done" });

  const r = (await fetch(`${gw.url}/api/sessions/clear-finished`, { method: "POST" }).then((x) =>
    x.json(),
  )) as { cleared: number };
  expect(r.cleared).toBeGreaterThanOrEqual(3); // ours + whatever earlier tests left behind

  const left = (await fetch(`${gw.url}/api/sessions`).then((x) => x.json())) as Array<{ id: string }>;
  const ids = new Set(left.map((s) => s.id));
  expect(ids.has(done)).toBe(false);
  expect(ids.has(failed)).toBe(false);
  expect(ids.has(killed)).toBe(false);
  expect(ids.has(liveOneshot)).toBe(true); // a live run is never cleared
  expect(ids.has(warmDone)).toBe(true); // warm chat history is never cleared
});

test("/api/attention surfaces a refining task with no live run as stalled (§6.1.g)", async () => {
  const task = await createViaApi("interrupted refinement");
  const moved = await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "refining" }),
  });
  expect(moved.status).toBe(200);
  // age it past the 60s "just dispatched" grace so the feed treats it as interrupted
  db.update(tasksTable)
    .set({ updatedAt: Date.now() - 120_000 })
    .where(eq(tasksTable.id, task.id))
    .run();

  const att = (await fetch(`${gw.url}/api/attention`).then((r) => r.json())) as {
    items: Array<{ kind: string; taskId?: string; summary: string }>;
  };
  const item = att.items.find((i) => i.kind === "stalled" && i.taskId === task.id);
  expect(item).toBeDefined();
  expect(item?.summary).toContain("Refinement interrupted");
});

test("PATCH /api/settings deep-merges per-agent overrides and clears them (§6.3.b)", async () => {
  // set a prompt override
  let res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agents: { discovery: { prompt: "DO IT for {{title}}" } } }),
  });
  expect(res.status).toBe(200);
  let settings = (await res.json()) as { agents?: Record<string, { prompt?: string; model?: string }> };
  expect(settings.agents?.discovery?.prompt).toBe("DO IT for {{title}}");

  // merging a model keeps the prompt (deep-merge, not replace)
  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agents: { discovery: { model: "claude-opus-4-8" } } }),
  });
  settings = (await res.json()) as typeof settings;
  expect(settings.agents?.discovery).toEqual({ prompt: "DO IT for {{title}}", model: "claude-opus-4-8" });

  // clearing the prompt keeps the model; clearing the model too removes the role entirely
  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agents: { discovery: { prompt: null } } }),
  });
  settings = (await res.json()) as typeof settings;
  expect(settings.agents?.discovery).toEqual({ model: "claude-opus-4-8" });

  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agents: { discovery: null } }),
  });
  settings = (await res.json()) as typeof settings;
  expect(settings.agents?.discovery).toBeUndefined();
});

test("GET /api/agents/prompts serves the registry with overrides merged (§6.3.c)", async () => {
  let list = (await fetch(`${gw.url}/api/agents/prompts`).then((r) => r.json())) as Array<{
    role: string;
    kind: string;
    label: string;
    variables: Array<{ name: string }>;
    defaultTemplate: string;
    override: { prompt?: string } | null;
  }>;
  const discovery = list.find((d) => d.role === "discovery");
  expect(discovery?.kind).toBe("stage");
  expect(discovery?.defaultTemplate).toContain("You are the Discovery agent");
  expect(discovery?.variables.map((v) => v.name)).toContain("title");
  expect(list.some((d) => d.role === "subagent:explorer" && d.kind === "subagent")).toBe(true);

  await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agents: { questioner: { prompt: "ASK BETTER {{title}}" } } }),
  });
  list = (await fetch(`${gw.url}/api/agents/prompts`).then((r) => r.json())) as typeof list;
  expect(list.find((d) => d.role === "questioner")?.override?.prompt).toBe("ASK BETTER {{title}}");

  // clean up so other tests see defaults
  await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agents: { questioner: null } }),
  });
});

test("PATCH /api/settings stores date/time format patterns and clears them (§6.3.d)", async () => {
  let res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ formats: { dateTime: "Y-m-d H:i" } }),
  });
  let s = (await res.json()) as { formats?: { date?: string; dateTime?: string } };
  expect(s.formats?.dateTime).toBe("Y-m-d H:i");
  expect(s.formats?.date).toBeUndefined(); // untouched key stays default-implicit

  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ formats: { dateTime: null } }),
  });
  s = (await res.json()) as typeof s;
  expect(s.formats?.dateTime).toBeUndefined(); // cleared → Czech default applies client-side
});

test("PATCH /api/settings stores operations knobs and clears invalid/null values (§6.3.e)", async () => {
  let res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operations: { maxConcurrentAgents: 8, stuckThresholdMinutes: -5 } }),
  });
  let s = (await res.json()) as { operations?: Record<string, number> };
  expect(s.operations?.maxConcurrentAgents).toBe(8);
  expect(s.operations?.stuckThresholdMinutes).toBeUndefined(); // invalid → ignored/cleared

  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operations: { maxConcurrentAgents: null } }),
  });
  s = (await res.json()) as typeof s;
  expect(s.operations?.maxConcurrentAgents).toBeUndefined(); // back to the built-in default
});

test("PATCH /api/settings stores ui.quickstartSeen and clears it (Quickstart)", async () => {
  let res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ui: { quickstartSeen: true } }),
  });
  let s = (await res.json()) as { ui?: { quickstartSeen?: boolean } };
  expect(s.ui?.quickstartSeen).toBe(true);

  // Survives unrelated patches (the merge keeps the ui group intact).
  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferredTerminal: "iTerm2" }),
  });
  s = (await res.json()) as typeof s;
  expect(s.ui?.quickstartSeen).toBe(true);

  // null clears the flag → the guide auto-opens again on next launch.
  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ui: { quickstartSeen: null } }),
  });
  s = (await res.json()) as typeof s;
  expect(s.ui?.quickstartSeen).toBeUndefined();
});

test("GET /api/projects/:slug/forge detects the forge from the remote (§6.4.a/b)", async () => {
  const project = (await fetch(`${gw.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Forge Probe", gitRemote: "git@github.com:acme/widget.git" }),
  }).then((r) => r.json())) as { slug: string };

  const status = (await fetch(`${gw.url}/api/projects/${project.slug}/forge`).then((r) =>
    r.json(),
  )) as { remote: { forge: string; owner: string; repo: string } | null; cli: { cli: string } | null };
  expect(status.remote?.forge).toBe("github");
  expect(status.remote?.owner).toBe("acme");
  expect(status.remote?.repo).toBe("widget");
  // cli reflects this machine (installed or not) — shape is the contract here
  if (status.cli) expect(status.cli.cli).toBe("gh");

  // forgeOverride round-trips through PATCH and reclassifies a custom host
  await fetch(`${gw.url}/api/projects/${project.slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gitRemote: "git@code.acme.dev:platform/app.git", forgeOverride: "gitlab" }),
  });
  const overridden = (await fetch(`${gw.url}/api/projects/${project.slug}/forge`).then((r) =>
    r.json(),
  )) as typeof status;
  expect(overridden.remote?.forge).toBe("gitlab");
});

test("review capture (§6.5.a): POST /api/tasks with review fields round-trips", async () => {
  const created = (await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body: "review https://github.com/acme/widget/pull/9",
      taskType: "code_review",
      reviewDirection: "address",
      reviewRef: "https://github.com/acme/widget/pull/9",
    }),
  }).then((r) => r.json())) as Task & { taskType: string; reviewDirection: string; reviewRef: string };
  expect(created.taskType).toBe("code_review");
  expect(created.reviewDirection).toBe("address");
  expect(created.reviewRef).toBe("https://github.com/acme/widget/pull/9");

  // persisted through markdown ⇄ index
  const fetched = (await fetch(`${gw.url}/api/tasks/${created.id}`).then((r) => r.json())) as typeof created;
  expect(fetched.taskType).toBe("code_review");
  expect(fetched.reviewDirection).toBe("address");
});

test("POST /api/review/inspect parses the URL, matches the project, infers direction (§6.5.a)", async () => {
  await fetch(`${gw.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Inspect Repo", gitRemote: "git@github.com:acme/inspect.git" }),
  });

  const r = (await fetch(`${gw.url}/api/review/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "see https://github.com/acme/inspect/pull/12 plz" }),
  }).then((x) => x.json())) as {
    ref: { owner: string; repo: string; number: number } | null;
    projectSlug: string | null;
    author: string | null;
    direction: string;
  };
  expect(r.ref?.owner).toBe("acme");
  expect(r.ref?.repo).toBe("inspect");
  expect(r.ref?.number).toBe(12);
  expect(r.projectSlug).toBe("inspect-repo");
  expect(r.author).toBe("octocat"); // injected by the harness — no real gh call
  expect(["perform", "address"]).toContain(r.direction);

  // a non-review URL inspects to ref:null with a safe default direction
  const none = (await fetch(`${gw.url}/api/review/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/nothing" }),
  }).then((x) => x.json())) as { ref: null; direction: string };
  expect(none.ref).toBeNull();
  expect(none.direction).toBe("perform");
});

test("review workspace endpoints (§6.5.e): findings round-trip, publish filters dismissed → done", async () => {
  const task = (await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Review widget PR",
      taskType: "code_review",
      reviewDirection: "perform",
      reviewRef: "https://github.com/acme/widget/pull/42",
    }),
  }).then((r) => r.json())) as Task;

  const findings = {
    summary: "One blocker, one nit.",
    verdictSuggestion: "request_changes",
    generatedAt: Date.now(),
    findings: [
      { severity: "blocker", file: "x.ts", line: 3, title: "Races", body: "B" },
      { severity: "nit", file: "y.ts", line: 9, title: "Naming", body: "N", decision: "dismiss" },
    ],
  };
  const put = await fetch(`${gw.url}/api/tasks/${task.id}/review-findings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(findings),
  });
  expect(put.status).toBe(200);
  const got = (await fetch(`${gw.url}/api/tasks/${task.id}/review-findings`).then((r) => r.json())) as {
    findings: Array<{ decision?: string }>;
  };
  expect(got.findings).toHaveLength(2);

  // move to review (where publishing happens), then publish
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });
  const before = publishedReviews.length;
  const pub = (await fetch(`${gw.url}/api/tasks/${task.id}/review/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "request_changes" }),
  }).then((r) => r.json())) as { published: boolean; comments: number; url: string | null };
  expect(pub.published).toBe(true);
  expect(pub.comments).toBe(1); // the dismissed nit never left the machine
  expect(publishedReviews.length).toBe(before + 1);
  expect(publishedReviews.at(-1)).toEqual({ verdict: "request_changes", comments: 1 });

  const after = (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task;
  expect(after.status).toBe("done");

  // Re-publishing is refused — even after manually moving the done task back to
  // Review, the on-disk publish stamp survives and the forge never gets a double post.
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });
  const again = await fetch(`${gw.url}/api/tasks/${task.id}/review/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "approve" }),
  });
  expect(again.status).toBe(409);
  expect(publishedReviews.length).toBe(before + 1); // still exactly one forge post
});

test("review replies endpoint (§6.5.f): posts non-skipped replies, resolves, → done", async () => {
  const task = (await fetch(`${gw.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Address feedback",
      taskType: "code_review",
      reviewDirection: "address",
      reviewRef: "https://github.com/acme/widget/pull/43",
    }),
  }).then((r) => r.json())) as Task;

  await fetch(`${gw.url}/api/tasks/${task.id}/review-proposal`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      generatedAt: Date.now(),
      overallNote: "",
      threads: [
        { threadId: "RT_1", classification: "must_fix", reply: "Fixed in abc.", resolves: true },
        { threadId: "RT_2", classification: "question", reply: "skipped", resolves: false, decision: "skip" },
      ],
    }),
  });
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "review" }),
  });

  const before = postedReplies.length;
  const res = (await fetch(`${gw.url}/api/tasks/${task.id}/review/replies`, { method: "POST" }).then((r) =>
    r.json(),
  )) as { posted: number; resolved: number; failed: number };
  expect(res).toEqual({ posted: 1, resolved: 1, failed: 0 });
  expect(postedReplies.length).toBe(before + 1);

  const after = (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task;
  expect(after.status).toBe("done");
});

test("PATCH /api/settings stores review strictness; invalid clears (§6.5.h)", async () => {
  let res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ review: { strictness: "strict" } }),
  });
  let s = (await res.json()) as { review?: { strictness?: string } };
  expect(s.review?.strictness).toBe("strict");

  res = await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ review: { strictness: "bananas" } }),
  });
  s = (await res.json()) as typeof s;
  expect(s.review?.strictness).toBeUndefined(); // invalid → back to default
});

// ---------------------------------------------------------------- lifecycle gap fixes

test("request-changes re-runs the implementation chain → task returns to Review", async () => {
  // A real repo-backed project so the chain actually runs (a project-less task bails).
  const repo = mkdtempSync(join(tmpdir(), "cadence-gw-reqch-"));
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# x\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);

  let implementerRuns = 0;
  implementerSideEffect = async ({ cwd }) => {
    implementerRuns += 1;
    // unique content per run — the work-product gate requires each run to change something
    writeFileSync(join(cwd, "feature.txt"), `revision ${implementerRuns}\n`);
  };
  const pollStatus = async (id: string, want: string, tries = 200): Promise<string> => {
    let status = "";
    for (let i = 0; i < tries && status !== want; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = ((await fetch(`${gw.url}/api/tasks/${id}`).then((r) => r.json())) as Task).status;
    }
    return status;
  };
  try {
    const project = (await fetch(`${gw.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Request Changes Repo", rootPath: repo, worktreesEnabled: true }),
    }).then((r) => r.json())) as { slug: string };
    const task = await createViaApi("Iterate on review feedback");
    await fetch(`${gw.url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: project.slug, status: "ready" }),
    });
    await fetch(`${gw.url}/api/tasks/${task.id}/play`, { method: "POST" });
    expect(await pollStatus(task.id, "plan_review")).toBe("plan_review");
    await fetch(`${gw.url}/api/tasks/${task.id}/plan/approve`, { method: "POST" });
    expect(await pollStatus(task.id, "review")).toBe("review"); // chain #1: implement → verify(pass) → review
    expect(implementerRuns).toBe(1);

    const res = await fetch(`${gw.url}/api/tasks/${task.id}/review/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "tighten the validation" }),
    });
    expect(res.status).toBe(200);

    // The fix: the chain re-runs (it used to park in Implementing forever) and the
    // task lands back in Review with the note on the context channel.
    expect(await pollStatus(task.id, "review")).toBe("review");
    expect(implementerRuns).toBe(2);
    const ctx = (await fetch(`${gw.url}/api/tasks/${task.id}/context`).then((r) => r.json())) as {
      content: string;
    };
    expect(ctx.content).toContain("Requested changes: tighten the validation");
  } finally {
    implementerSideEffect = null;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("plan-approve refuses an empty plan (409) — no unplanned free-running implementer", async () => {
  const task = await createViaApi("Approve nothing");
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "plan_review" }),
  });
  const res = await fetch(`${gw.url}/api/tasks/${task.id}/plan/approve`, { method: "POST" });
  expect(res.status).toBe(409);
  // and the task did not move into implementing
  const after = (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task;
  expect(after.status).toBe("plan_review");
});

test("re-submitting answers neither duplicates context nor yanks the status", async () => {
  const task = await createViaApi("Answer dedupe");
  writeQa(task.id, {
    questions: [{ id: "q1", rank: 1, type: "text", text: "Which auth provider?" }],
    answers: {},
  });
  await fetch(`${gw.url}/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "needs_feedback" }),
  });

  const submit = (answers: Record<string, string>) =>
    fetch(`${gw.url}/api/tasks/${task.id}/qa/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    }).then((r) => r.json()) as Promise<{ status: string }>;
  const contextNow = async () =>
    ((await fetch(`${gw.url}/api/tasks/${task.id}/context`).then((r) => r.json())) as { content: string })
      .content;
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  // first submit: answers recorded once, task advances to Ready
  expect((await submit({ q1: "GitHub OAuth" })).status).toBe("ready");
  expect(count(await contextNow(), "A: GitHub OAuth")).toBe(1);

  // identical re-submit (the card stays editable in Needs-Feedback): no duplicate
  // context entry, and the lifecycle is not yanked around
  expect((await submit({ q1: "GitHub OAuth" })).status).toBe("ready");
  expect(count(await contextNow(), "A: GitHub OAuth")).toBe(1);

  // a CHANGED answer is recorded (that's new information), status still untouched
  expect((await submit({ q1: "SAML" })).status).toBe("ready");
  const ctx = await contextNow();
  expect(count(ctx, "A: GitHub OAuth")).toBe(1);
  expect(count(ctx, "A: SAML")).toBe(1);
});

test("attention surfaces a dead capture pipeline (autonomy on, triage attempt died)", async () => {
  // Build the evidence trail with autonomy OFF (no real spawn): a task stuck in
  // inbox whose only triage attempt is a dead session row.
  const task = await createViaApi("triage died on me");
  db.insert(sessions)
    .values({
      id: crypto.randomUUID(),
      taskId: task.id,
      role: "triage",
      kind: "oneshot",
      status: "failed",
      cwd: "/tmp",
      costUsd: 0,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 110_000,
    })
    .run();
  // age the task past the 60s grace window
  db.update(tasksTable).set({ updatedAt: Date.now() - 120_000 }).where(eq(tasksTable.id, task.id)).run();

  // a fresh inbox task with NO attempt must never be flagged (manual capture is a valid resting state)
  const resting = await createViaApi("resting in inbox");
  db.update(tasksTable).set({ updatedAt: Date.now() - 120_000 }).where(eq(tasksTable.id, resting.id)).run();

  await fetch(`${gw.url}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ global: { autonomy: true } }),
  });
  try {
    const att = (await fetch(`${gw.url}/api/attention`).then((r) => r.json())) as {
      items: Array<{ id: string; kind: string; taskId?: string; summary: string }>;
    };
    const item = att.items.find((i) => i.taskId === task.id);
    expect(item?.kind).toBe("stalled");
    expect(item?.summary).toContain("triage never finished");
    expect(att.items.some((i) => i.taskId === resting.id)).toBe(false);
  } finally {
    await fetch(`${gw.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ global: { autonomy: false } }),
    });
  }
});

test("POST /api/tasks/:id/git-context/check re-checks and persists the git outcome", async () => {
  // A real (temp) git repo whose task branch was merged outside Cadence.
  const repo = mkdtempSync(join(tmpdir(), "cadence-gw-repo-"));
  const git = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  try {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@e.com"]);
    git(["config", "user.name", "T"]);
    writeFileSync(join(repo, "README.md"), "# r\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    git(["checkout", "-q", "-b", "cadence/manual-test"]);
    writeFileSync(join(repo, "f.txt"), "f\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "work"]);
    git(["checkout", "-q", "main"]);
    git(["merge", "--no-ff", "-q", "-m", "merged in a terminal", "cadence/manual-test"]);

    const project = (await fetch(`${gw.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitCtx", rootPath: repo }),
    }).then((r) => r.json())) as { slug: string };
    const task = (await fetch(`${gw.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Git ctx task", project: project.slug }),
    }).then((r) => r.json())) as Task;
    // a pre-feature delivery: delivery.md exists, no gitContext on the task yet
    writeDelivery(task.id, {
      mode: "branch_summary",
      summary: "did it",
      branch: "cadence/manual-test",
      prUrl: null,
    });

    const res = await fetch(`${gw.url}/api/tasks/${task.id}/git-context/check`, { method: "POST" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { gitContext: { merged: string; baseBranch: string | null } | null; changed: boolean };
    expect(out.changed).toBe(true);
    expect(out.gitContext).toMatchObject({ merged: "merged", baseBranch: "main" });

    // persisted: the task DTO now carries the context
    const after = (await fetch(`${gw.url}/api/tasks/${task.id}`).then((r) => r.json())) as Task;
    expect(after.gitContext).toMatchObject({ merged: "merged", mergedVia: "external" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
