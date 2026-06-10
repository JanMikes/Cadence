import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import { sessions } from "./db/schema";
import { getSession } from "./sessions";
import { bootstrap } from "./store/store";
import { createTask, getTask, updateTask } from "./tasks";
import { checkSessions, isProcessAlive, reconcileOrphans } from "./watchdog";
import { WsHub } from "./ws";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-wd-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

const DEAD_PID = 2 ** 31 - 1; // a pid that won't exist

function insertSession(over: Partial<typeof sessions.$inferInsert> & { id?: string } = {}): string {
  const id = over.id ?? crypto.randomUUID();
  db.insert(sessions)
    .values({
      id,
      taskId: over.taskId ?? null,
      role: over.role ?? "implementer",
      kind: over.kind ?? "oneshot",
      status: over.status ?? "running",
      cwd: over.cwd ?? "/tmp",
      costUsd: 0,
      startedAt: over.startedAt ?? Date.now(),
      pid: over.pid ?? null,
      transcriptPath: over.transcriptPath ?? null,
    })
    .run();
  return id;
}

function implementingTask(title: string): string {
  const t = createTask(db, { title });
  updateTask(db, t.id, { status: "ready" });
  updateTask(db, t.id, { status: "implementing" });
  return t.id;
}

test("isProcessAlive: true for this process, false for a non-existent pid", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(DEAD_PID)).toBe(false);
});

test("reconcileOrphans ends a running session and rescues its stranded task", () => {
  const taskId = implementingTask("interrupted implement");
  const sid = insertSession({ taskId, status: "running", role: "implementer" });

  const ended = reconcileOrphans(db, new WsHub());

  expect(ended).toBe(1);
  expect(getSession(db, sid)?.status).toBe("failed");
  // no plan + no diff → moved to Ready (re-PLAY), out of the silent "implementing"
  expect(getTask(db, taskId)?.status).toBe("ready");
});

test("reconcileOrphans rescues an active-work task even with no session row", () => {
  const taskId = implementingTask("stranded");
  updateTask(db, taskId, { status: "verifying" });

  reconcileOrphans(db, new WsHub());

  expect(getTask(db, taskId)?.status).not.toBe("verifying");
  expect(getTask(db, taskId)?.status).not.toBe("implementing");
});

test("checkSessions: a running session with a dead pid is ended and its task rescued", () => {
  const taskId = implementingTask("dead pid");
  const sid = insertSession({ taskId, status: "running", pid: DEAD_PID });

  const r = checkSessions(db, new WsHub(), new Set());

  expect(r.dead).toBe(1);
  expect(getSession(db, sid)?.status).toBe("failed");
  expect(getTask(db, taskId)?.status).not.toBe("implementing");
});

test("checkSessions: a live fresh session is left alone; a long-idle one is surfaced once", () => {
  const hub = new WsHub();
  const now = Date.now();
  const liveId = insertSession({ status: "running", pid: 11111, startedAt: now });
  const idleId = insertSession({
    status: "running",
    pid: 22222, // honestly alive for an hour (signature matches) — only the idleness flags it
    startedAt: now - 60 * 60 * 1000, // 1h ago, no transcript → idle
  });
  // Probe an honest world: both processes exist, are not defunct, and their start
  // times match their rows (etime ≈ how long ago the row says it started).
  const probe = {
    alive: () => true,
    proc: (pid: number) => ({ stat: "S+", etimeSec: pid === 22222 ? 3600 : 5, command: "claude" }),
    now: Date.now,
  };
  const notified = new Set<string>();

  const r1 = checkSessions(db, hub, notified, now, probe);
  expect(getSession(db, liveId)?.status).toBe("running"); // untouched
  expect(r1.dead).toBe(0);
  expect(r1.stuck).toBe(1);
  expect(notified.has(idleId)).toBe(true);

  // a second pass must not re-nudge the same session
  expect(checkSessions(db, hub, notified, now, probe).stuck).toBe(0);
});

test("checkSessions sweep: a DEFUNCT zombie (passes kill(0)) is finalized and its task rescued (§6.1.d)", () => {
  // The 17-zombie incident: dead discovery runs whose pids sat defunct for 15+ hours.
  const taskId = implementingTask("zombie bait");
  const sid = insertSession({ taskId, status: "running", pid: 4242, role: "implementer" });
  const probe = {
    alive: () => true, // kill(0) lies for defunct processes — exactly the incident
    proc: () => ({ stat: "Z+", etimeSec: 5, command: "(claude)" }),
    now: Date.now,
  };

  const r = checkSessions(db, new WsHub(), new Set(), Date.now(), probe);

  expect(r.dead).toBe(1);
  expect(getSession(db, sid)?.status).toBe("failed");
  expect(getTask(db, taskId)?.status).not.toBe("implementing");
});

test("checkSessions sweep: a recycled pid (start-time signature mismatch) is finalized (§6.1.d)", () => {
  const sid = insertSession({
    status: "running",
    pid: 33333,
    startedAt: Date.now() - 2 * 60 * 60 * 1000, // the row is 2h old…
  });
  const probe = {
    alive: () => true,
    proc: () => ({ stat: "S+", etimeSec: 10, command: "some-other-process" }), // …the pid is 10s old
    now: Date.now,
  };

  const r = checkSessions(db, new WsHub(), new Set(), Date.now(), probe);

  expect(r.dead).toBe(1);
  expect(getSession(db, sid)?.status).toBe("failed");
});

test("reconcileOrphans: a defunct survivor is NOT kept running at boot (§6.1.d)", () => {
  const taskId = implementingTask("boot zombie");
  const sid = insertSession({ taskId, status: "running", pid: 4242, role: "implementer" });
  const probe = {
    alive: () => true,
    proc: () => ({ stat: "Z", etimeSec: 100, command: "(claude)" }),
    now: Date.now,
  };

  const ended = reconcileOrphans(db, new WsHub(), probe);

  expect(ended).toBe(1);
  expect(getSession(db, sid)?.status).toBe("failed");
  expect(getTask(db, taskId)?.status).toBe("ready"); // rescued, re-PLAYable
});

test("reconcileOrphans leaves a WARM chat whose process survived the restart running", () => {
  const taskId = implementingTask("survivor");
  const sid = insertSession({ taskId, status: "running", role: "chat", kind: "warm", pid: process.pid });

  const ended = reconcileOrphans(db, new WsHub());

  expect(ended).toBe(0);
  expect(getSession(db, sid)?.status).toBe("running"); // still honestly (and usefully) running
  expect(getTask(db, taskId)?.status).toBe("implementing"); // not rescued — its run is alive
});

test("reconcileOrphans KILLS an orphaned-but-alive one-shot — its result can never reach the task (§6.1.e)", async () => {
  // A real child stands in for the orphan; reconcile must stop it, not babysit it.
  const orphan = Bun.spawn(["sleep", "30"]);
  try {
    const taskId = implementingTask("orphaned implement");
    const sid = insertSession({ taskId, status: "running", role: "implementer", pid: orphan.pid });

    const ended = reconcileOrphans(db, new WsHub());

    expect(ended).toBe(1);
    expect(getSession(db, sid)?.status).toBe("killed");
    expect(getTask(db, taskId)?.status).toBe("ready"); // rescued → re-PLAYable
    // SIGTERM actually landed — the process exits (don't wait for the 5s SIGKILL escalation)
    const exited = await Promise.race([
      orphan.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 2_000)),
    ]);
    expect(exited).toBe(true);
  } finally {
    orphan.kill(9);
  }
});

// ------------------------------------------------ work attribution + boot repair

import { mkdtempSync as mkd, writeFileSync as wf } from "node:fs";
import { join as j } from "node:path";
import { tmpdir as tmp } from "node:os";
import { createProject } from "./projects";
import { applyPlan } from "./agents/planner";
import { restoreAbandonedExecutions } from "./watchdog";
import { beginInPlaceExecution, branchName, readExecutionState } from "./worktree";

function gitRepo(): string {
  const repo = mkd(j(tmp(), "cadence-wd-repo-"));
  const g = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  wf(j(repo, "README.md"), "# r\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);
  return repo;
}

function gitIn(repo: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim();
}

test("INCIDENT REPLAY: a dead apply_in_place run is NOT promoted to review off the user's dirty tree", () => {
  // The route-state incident (2026-06-10): implementer killed by a restart before
  // doing anything; the user's own uncommitted work made taskDiff non-empty; the
  // task sailed to review and was merged as done with zero delivered code.
  const repo = gitRepo();
  try {
    const project = createProject(db, { name: "Shared", rootPath: repo });
    const t = createTask(db, { title: "Preserve route state" });
    updateTask(db, t.id, { project: project.slug, deliveryMode: "apply_in_place" });
    applyPlan(t.id, { steps: [{ title: "implement it" }] }); // a plan exists
    updateTask(db, t.id, { status: "ready" });
    updateTask(db, t.id, { status: "implementing" });

    wf(j(repo, "README.md"), "# r\nthe user's unrelated WIP\n"); // dirty tree ≠ task work

    reconcileOrphans(db, new WsHub());

    // honest recovery: no recorded run → plan_review (re-approve), NOT review
    expect(getTask(db, t.id)?.status).toBe("plan_review");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a dead in-place run WITH committed branch work IS promoted to review", () => {
  const repo = gitRepo();
  try {
    const project = createProject(db, { name: "InPlace", rootPath: repo });
    const t = createTask(db, { title: "Real work" });
    updateTask(db, t.id, { project: project.slug });
    updateTask(db, t.id, { status: "ready" });
    updateTask(db, t.id, { status: "implementing" });
    beginInPlaceExecution(db, t.id); // checks out the task branch
    wf(j(repo, "feature.txt"), "real\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-q", "-m", "real work"]);

    reconcileOrphans(db, new WsHub());

    expect(getTask(db, t.id)?.status).toBe("review");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("restoreAbandonedExecutions secures interrupted work and restores the base branch", () => {
  const repo = gitRepo();
  try {
    const project = createProject(db, { name: "Restore", rootPath: repo });
    const t = createTask(db, { title: "Interrupted" });
    updateTask(db, t.id, { project: project.slug });
    wf(j(repo, ".env"), "SECRET=1\n"); // user's untracked file — must stay out
    beginInPlaceExecution(db, t.id);
    wf(j(repo, "half-done.txt"), "WIP from the dead run\n"); // uncommitted task work
    expect(gitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branchName(t));

    const restored = restoreAbandonedExecutions(db, new WsHub());

    expect(restored).toBe(1);
    expect(gitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main"); // base restored
    expect(readExecutionState(t.id)).toBeNull(); // state cleared
    // the WIP survived — committed on the task branch, not lost, not on main
    const committed = gitIn(repo, ["show", "--name-only", "--pretty=format:", branchName(t)]);
    expect(committed).toContain("half-done.txt");
    expect(committed).not.toContain(".env");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("restoreAbandonedExecutions leaves a repo alone when a live run still owns the task", () => {
  const repo = gitRepo();
  try {
    const project = createProject(db, { name: "Live", rootPath: repo });
    const t = createTask(db, { title: "Still running" });
    updateTask(db, t.id, { project: project.slug });
    beginInPlaceExecution(db, t.id);
    insertSession({ taskId: t.id, status: "running", pid: process.pid }); // genuinely alive

    expect(restoreAbandonedExecutions(db, new WsHub())).toBe(0);
    expect(gitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branchName(t)); // untouched
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
