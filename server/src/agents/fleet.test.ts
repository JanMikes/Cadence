import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createFleet } from "../fleets";
import { createProject } from "../projects";
import { bootstrap } from "../store/store";
import { createTask, getTask, updateTask } from "../tasks";
import { applyPlan, approvePlan } from "./planner";
import { runFleetImplementer } from "./fleet";
import type { AgentRunOptions } from "./runner";

let db: Db;
let home: string;
let worktrees: string;
const repos: string[] = [];

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function makeRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `cadence-fleet-${label}-`));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), `# ${label}\n`);
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  repos.push(repo);
  return repo;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-fleet-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
  worktrees = mkdtempSync(join(tmpdir(), "cadence-fleet-wt-"));
  process.env.CADENCE_WORKTREES = worktrees;
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_WORKTREES;
  rmSync(home, { recursive: true, force: true });
  rmSync(worktrees, { recursive: true, force: true });
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ok = (): Promise<AgentResult> =>
  Promise.resolve({ text: "ok", json: null, costUsd: 0.25, sessionId: "s", isError: false, raw: {} });

test("runFleetImplementer runs the Implementer in a worktree per member repo", async () => {
  const apiRepo = makeRepo("api");
  const webRepo = makeRepo("web");
  // Fleet runs require worktree isolation — members opt in.
  const api = createProject(db, { name: "API", rootPath: apiRepo, worktreesEnabled: true });
  const web = createProject(db, { name: "Web", rootPath: webRepo, worktreesEnabled: true });
  const fleet = createFleet(db, { name: "Stack", projects: [api.slug, web.slug] });

  const task = createTask(db, { title: "Cross-repo change" });
  updateTask(db, task.id, { fleet: fleet.slug, status: "implementing" });
  applyPlan(task.id, { steps: [{ title: "do it in both repos" }] });
  approvePlan(task.id);

  const cwds: string[] = [];
  const capture = (opts: AgentRunOptions): Promise<AgentResult> => {
    cwds.push(opts.cwd);
    return ok();
  };
  const outcome = await runFleetImplementer(db, task.id, capture);

  expect(outcome.ran).toBe(true);
  expect(outcome.result?.results).toHaveLength(2);
  // each repo got its own isolated worktree
  expect(cwds).toHaveLength(2);
  expect(cwds.every((c) => c.startsWith(worktrees))).toBe(true);
  expect(new Set(cwds).size).toBe(2); // distinct per repo
  for (const sub of outcome.result?.results ?? []) {
    expect(sub.ran).toBe(true);
    expect(existsSync(sub.cwd)).toBe(true);
    expect(sub.branch).toContain("cadence/");
  }
  // any repo ran → task advanced to verifying
  expect(getTask(db, task.id)?.status).toBe("verifying");
});

test("runFleetImplementer skips members with worktrees disabled (visible reason, no run)", async () => {
  const onRepo = makeRepo("on");
  const offRepo = makeRepo("off");
  const on = createProject(db, { name: "On", rootPath: onRepo, worktreesEnabled: true });
  const off = createProject(db, { name: "Off", rootPath: offRepo }); // default: disabled
  const fleet = createFleet(db, { name: "Mixed", projects: [on.slug, off.slug] });

  const task = createTask(db, { title: "Mixed fleet change" });
  updateTask(db, task.id, { fleet: fleet.slug, status: "implementing" });
  applyPlan(task.id, { steps: [{ title: "do it" }] });
  approvePlan(task.id);

  const cwds: string[] = [];
  const capture = (opts: AgentRunOptions): Promise<AgentResult> => {
    cwds.push(opts.cwd);
    return ok();
  };
  const outcome = await runFleetImplementer(db, task.id, capture);

  expect(outcome.ran).toBe(true);
  expect(cwds).toHaveLength(1); // only the opted-in member actually ran
  const offResult = outcome.result?.results.find((r) => r.projectSlug === off.slug);
  expect(offResult?.ran).toBe(false);
  expect(offResult?.reason).toMatch(/worktrees disabled/);
});

test("runFleetImplementer bails when the task isn't on a fleet or the plan isn't approved", async () => {
  const solo = createTask(db, { title: "Solo" });
  updateTask(db, solo.id, { status: "implementing" });
  const soloOutcome = await runFleetImplementer(db, solo.id, ok);
  expect(soloOutcome.ran).toBe(false);
  expect(soloOutcome.reason).toContain("not assigned");

  const fleet = createFleet(db, { name: "Empty", projects: [] });
  const task = createTask(db, { title: "Unapproved" });
  updateTask(db, task.id, { fleet: fleet.slug, status: "implementing" });
  applyPlan(task.id, { steps: [{ title: "x" }] }); // not approved
  expect(await runFleetImplementer(db, task.id, ok)).toMatchObject({ ran: false, reason: "plan not approved" });
});
