import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createProject, failStaleWorktreeCheckRuns, getProject, setProjectWorktreeCheckRun } from "../projects";
import { bootstrap } from "../store/store";
import type { AgentRunOptions } from "./runner";
import { buildWorktreeCheckPrompt, runWorktreeCheck } from "./worktree-check";

let db: Db;
let home: string;
let repo: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-wtcheck-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  repo = mkdtempSync(join(tmpdir(), "cadence-wtcheck-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const result = (json: unknown): Promise<AgentResult> =>
  Promise.resolve({ text: JSON.stringify(json), json, costUsd: 0, sessionId: "s", isError: false, raw: {} });

test("buildWorktreeCheckPrompt asks for the strict JSON verdict shape", () => {
  const p = buildWorktreeCheckPrompt();
  expect(p).toContain("FRESH");
  expect(p).toContain('"verdict":"ready|blockers"');
});

test("runWorktreeCheck persists a parsed verdict on the project (read-only run in the repo)", async () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });

  const calls: AgentRunOptions[] = [];
  const out = await runWorktreeCheck(db, project.slug, (opts) => {
    calls.push(opts);
    return result({
      verdict: "blockers",
      summary: "Repo needs a per-checkout .env.",
      blockers: [
        { title: ".env is not committed", detail: "required at boot", severity: "high" },
        { title: "node_modules install", detail: "", severity: "weird" }, // bad severity → normalized
      ],
      recommendation: "Commit an .env.example and load defaults.",
    });
  });

  expect(out.ran).toBe(true);
  expect(calls[0]?.cwd).toBe(repo);
  expect(calls[0]?.permissionMode).toBe("plan"); // read-only — it only inspects
  expect(calls[0]?.role).toBe("worktree_check");

  const saved = getProject(db, project.slug)?.worktreeCheck;
  expect(saved?.verdict).toBe("blockers");
  expect(saved?.blockers).toHaveLength(2);
  expect(saved?.blockers[1]?.severity).toBe("medium"); // unknown severity normalized
  expect(saved?.checkedAt).toBeGreaterThan(0);
  // the toggle is NOT flipped — propose, don't impose
  expect(getProject(db, project.slug)?.worktreesEnabled).toBe(false);
});

test('an inconsistent "ready with blockers" answer resolves to blockers', async () => {
  const project = createProject(db, { name: "Repo2", rootPath: repo });
  const out = await runWorktreeCheck(db, project.slug, () =>
    result({ verdict: "ready", summary: "ok", blockers: [{ title: "ports", severity: "low" }] }),
  );
  expect(out.check?.verdict).toBe("blockers");
});

test("runWorktreeCheck bails gracefully on unusable JSON or a missing rootPath", async () => {
  const project = createProject(db, { name: "Repo3", rootPath: repo });
  const bad = await runWorktreeCheck(db, project.slug, () => result({ nope: true }));
  expect(bad.ran).toBe(false);
  expect(getProject(db, project.slug)?.worktreeCheck).toBeNull(); // no verdict persisted
  // …but the failure itself IS persisted, so the UI can show it after the panel closed
  expect(getProject(db, project.slug)?.worktreeCheckRun).toMatchObject({
    status: "failed",
    reason: "readiness check returned no usable JSON",
  });

  const pathless = createProject(db, { name: "NoRoot" });
  const out = await runWorktreeCheck(db, pathless.slug, () => result({}));
  expect(out).toMatchObject({ ran: false, reason: "project has no rootPath" });
  expect(getProject(db, pathless.slug)?.worktreeCheckRun).toBeNull(); // never started
});

test("the lifecycle is persisted: running while in flight, cleared by the verdict", async () => {
  const project = createProject(db, { name: "Repo4", rootPath: repo });

  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const outcome = runWorktreeCheck(db, project.slug, async () => {
    await gate;
    return result({ verdict: "ready", summary: "all clear", blockers: [] });
  });

  // before the agent answers, the project already says "running" — any panel sees it
  const running = getProject(db, project.slug)?.worktreeCheckRun;
  expect(running?.status).toBe("running");
  expect(running?.startedAt).toBeGreaterThan(0);

  release?.();
  const out = await outcome;
  expect(out.ran).toBe(true);
  const after = getProject(db, project.slug);
  expect(after?.worktreeCheck?.verdict).toBe("ready");
  expect(after?.worktreeCheckRun).toBeNull(); // verdict clears the lifecycle
});

test("a failed run persists its reason and keeps the previous verdict intact", async () => {
  const project = createProject(db, { name: "Repo5", rootPath: repo });
  await runWorktreeCheck(db, project.slug, () =>
    result({ verdict: "ready", summary: "all clear", blockers: [] }),
  );

  // agent error → failed run persisted, old verdict untouched
  const errored = await runWorktreeCheck(db, project.slug, () =>
    Promise.resolve({ text: "boom", json: null, costUsd: 0, sessionId: "s", isError: true, raw: {} }),
  );
  expect(errored.ran).toBe(false);
  let p = getProject(db, project.slug);
  expect(p?.worktreeCheckRun).toMatchObject({ status: "failed", reason: "readiness check agent errored" });
  expect(p?.worktreeCheck?.verdict).toBe("ready"); // last good verdict survives a failed re-check

  // a crashing runner never throws out of runWorktreeCheck — it persists the failure too
  const crashed = await runWorktreeCheck(db, project.slug, () => Promise.reject(new Error("ECONNRESET")));
  expect(crashed.ran).toBe(false);
  p = getProject(db, project.slug);
  expect(p?.worktreeCheckRun?.status).toBe("failed");
  expect(p?.worktreeCheckRun?.reason).toContain("ECONNRESET");
});

test("failStaleWorktreeCheckRuns marks checks orphaned by a dead gateway as failed", async () => {
  const project = createProject(db, { name: "Repo6", rootPath: repo });
  setProjectWorktreeCheckRun(db, project.slug, { status: "running", startedAt: 123, reason: null });
  const untouched = createProject(db, { name: "Repo7", rootPath: repo });

  expect(failStaleWorktreeCheckRuns(db)).toBe(1);
  const run = getProject(db, project.slug)?.worktreeCheckRun;
  expect(run?.status).toBe("failed");
  expect(run?.startedAt).toBe(123);
  expect(run?.reason).toContain("gateway restarted");
  expect(getProject(db, untouched.slug)?.worktreeCheckRun).toBeNull();

  expect(failStaleWorktreeCheckRuns(db)).toBe(0); // idempotent — failed runs stay as they are
});
