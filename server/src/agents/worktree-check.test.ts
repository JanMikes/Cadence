import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { createProject, getProject } from "../projects";
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
  expect(getProject(db, project.slug)?.worktreeCheck).toBeNull(); // nothing persisted

  const pathless = createProject(db, { name: "NoRoot" });
  const out = await runWorktreeCheck(db, pathless.slug, () => result({}));
  expect(out).toMatchObject({ ran: false, reason: "project has no rootPath" });
});
