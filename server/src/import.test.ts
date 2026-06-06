import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import { importProjects, scanClaudeProjects } from "./import";
import { getProjectByRootPath } from "./projects";
import { bootstrap } from "./store/store";

let db: Db;
let home: string;
let claude: string;
let repo: string;

/** Write a project dir under the fake ~/.claude/projects with a transcript naming `cwd`. */
function fakeProjectDir(encoded: string, cwd: string, gitBranch = "main") {
  const dir = join(claude, "projects", encoded);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: "user", cwd, gitBranch, message: { role: "user", content: "hi" } });
  writeFileSync(join(dir, "sess.jsonl"), `${line}\n`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-imp-home-"));
  claude = mkdtempSync(join(tmpdir(), "cadence-imp-claude-"));
  process.env.CADENCE_HOME = home;
  process.env.CADENCE_CLAUDE_DIR = claude;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);

  // a real on-disk git repo to be detected
  repo = mkdtempSync(join(tmpdir(), "my-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.com/me/my-repo.git"], {
    stdio: "ignore",
  });
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_CLAUDE_DIR;
  for (const d of [home, claude, repo]) rmSync(d, { recursive: true, force: true });
});

test("scanClaudeProjects detects real on-disk dirs (cwd from transcript, not the lossy dir name)", () => {
  fakeProjectDir("encoded-repo", repo, "feature/x");
  fakeProjectDir("-private-tmp-gone-123", "/private/tmp/this-does-not-exist-xyz"); // filtered out

  const candidates = scanClaudeProjects(db);
  const mine = candidates.find((c) => c.cwd === repo);
  expect(mine).toBeDefined();
  expect(mine?.isGitRepo).toBe(true);
  expect(mine?.gitRemote).toBe("https://example.com/me/my-repo.git");
  expect(mine?.gitBranch).toBe("feature/x");
  expect(mine?.alreadyImported).toBe(false);
  // the non-existent cwd is not proposed
  expect(candidates.some((c) => c.cwd.includes("does-not-exist"))).toBe(false);
});

test("importProjects creates the selected candidates and is idempotent", () => {
  const created = importProjects(db, [
    { cwd: repo, name: "My Repo", gitRemote: "https://example.com/me/my-repo.git" },
  ]);
  expect(created).toHaveLength(1);
  expect(created[0]?.rootPath).toBe(repo);
  expect(getProjectByRootPath(db, repo)?.name).toBe("My Repo");

  // re-importing the same cwd is a no-op (already imported)
  expect(importProjects(db, [{ cwd: repo, name: "My Repo Again" }])).toHaveLength(0);

  // and scan now marks it imported
  fakeProjectDir("encoded-repo", repo);
  expect(scanClaudeProjects(db).find((c) => c.cwd === repo)?.alreadyImported).toBe(true);
});
