import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createProject } from "../projects";
import { bootstrap, readDelivery } from "../store/store";
import { createTask, resolveDeliveryMode, updateTask } from "../tasks";
import { buildDeliveryPrompt, runDelivery } from "./delivery";

let db: Db;
let home: string;
let repo: string;
let worktrees: string;

function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-del-home-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  repo = mkdtempSync(join(tmpdir(), "cadence-del-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# r\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  worktrees = mkdtempSync(join(tmpdir(), "cadence-del-wt-"));
  process.env.CADENCE_WORKTREES = worktrees;
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_WORKTREES;
  for (const d of [home, repo, worktrees]) rmSync(d, { recursive: true, force: true });
});

const summaryResult = (summary: string): Promise<AgentResult> =>
  Promise.resolve({
    text: "x",
    json: { summary },
    costUsd: 0,
    sessionId: "s",
    isError: false,
    raw: {},
  });

test("resolveDeliveryMode resolves task ?? project ?? global", () => {
  const project = createProject(db, { name: "P", rootPath: repo, defaultDeliveryMode: "auto_pr" });
  const task = createTask(db, { title: "T" });
  updateTask(db, task.id, { project: project.slug });
  expect(resolveDeliveryMode(db, task.id)).toBe("auto_pr"); // project default
  updateTask(db, task.id, { deliveryMode: "apply_in_place" });
  expect(resolveDeliveryMode(db, task.id)).toBe("apply_in_place"); // task override wins
});

test("buildDeliveryPrompt references the verify checks", () => {
  const p = buildDeliveryPrompt({ title: "T", body: "" }, "SPEC", {
    passed: true,
    checks: [{ name: "tests", passed: true }],
    criteria: [],
    issues: [],
  });
  expect(p).toContain("VERIFY CHECKS");
  expect(p).toContain("tests");
});

test("branch_summary delivery writes a summary + branch, no PR (no push)", async () => {
  const project = createProject(db, { name: "Repo", rootPath: repo });
  const task = createTask(db, { title: "Ship it" });
  updateTask(db, task.id, { project: project.slug, status: "review" });

  const outcome = await runDelivery(db, task.id, () => summaryResult("Did the thing."));
  expect(outcome).toMatchObject({ ran: true, mode: "branch_summary", prUrl: null });
  expect(outcome.branch).toContain("cadence/");

  const delivery = readDelivery(task.id);
  expect(delivery?.summary).toBe("Did the thing.");
  expect(delivery?.mode).toBe("branch_summary");
  expect(delivery?.branch).toBe(outcome.branch ?? null);
});

test("apply_in_place delivery has no branch/PR", async () => {
  const project = createProject(db, { name: "Repo2", rootPath: repo });
  const task = createTask(db, { title: "In place" });
  updateTask(db, task.id, { project: project.slug, deliveryMode: "apply_in_place", status: "review" });

  const outcome = await runDelivery(db, task.id, () => summaryResult("Edited in place."));
  expect(outcome).toMatchObject({ ran: true, mode: "apply_in_place", branch: null, prUrl: null });
  expect(readDelivery(task.id)?.summary).toBe("Edited in place.");
});
