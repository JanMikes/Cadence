import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeReviewBranch, prepareReviewBranch } from "./review-branch";

let root: string;
let origin: string;
let clone: string;

const g = (args: string[], cwd: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cadence-rb-"));
  origin = join(root, "origin.git");
  clone = join(root, "clone");
  Bun.spawnSync(["git", "init", "--bare", "-q", origin]);
  Bun.spawnSync(["git", "clone", "-q", origin, clone]);
  g(["config", "user.email", "t@e.com"], clone);
  g(["config", "user.name", "T"], clone);
  g(["checkout", "-q", "-b", "main"], clone);
  writeFileSync(join(clone, "a.txt"), "base\n");
  g(["add", "."], clone);
  g(["commit", "-qm", "base"], clone);
  g(["push", "-qu", "origin", "main"], clone);
  // the "PR branch" exists on origin, not locally
  g(["checkout", "-q", "-b", "fix/login"], clone);
  writeFileSync(join(clone, "a.txt"), "pr change\n");
  g(["add", "."], clone);
  g(["commit", "-qm", "pr work"], clone);
  g(["push", "-qu", "origin", "fix/login"], clone);
  g(["checkout", "-q", "main"], clone);
  g(["branch", "-qD", "fix/login"], clone); // simulate: branch only on origin
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("prepare checks out the remote PR branch; finalize pushes and restores (§6.5.d)", () => {
  const prep = prepareReviewBranch(clone, "fix/login");
  expect(prep.ok).toBe(true);
  expect(prep.previousBranch).toBe("main");
  expect(g(["rev-parse", "--abbrev-ref", "HEAD"], clone)).toBe("fix/login");

  // the "agent" commits a fix
  writeFileSync(join(clone, "a.txt"), "fixed per review\n");
  g(["add", "."], clone);
  g(["commit", "-qm", "address review"], clone);

  const fin = finalizeReviewBranch(clone, "fix/login", "main");
  expect(fin.pushed).toBe(true);
  expect(fin.restored).toBe(true);
  expect(g(["rev-parse", "--abbrev-ref", "HEAD"], clone)).toBe("main");
  // the fix reached origin
  expect(g(["log", "origin/fix/login", "-1", "--format=%s"], clone)).toBe("address review");
});

test("prepare refuses a dirty tree — the user's checkout is sacred", () => {
  writeFileSync(join(clone, "a.txt"), "uncommitted\n");
  const prep = prepareReviewBranch(clone, "fix/login");
  expect(prep.ok).toBe(false);
  expect(prep.reason).toContain("uncommitted");
  expect(g(["rev-parse", "--abbrev-ref", "HEAD"], clone)).toBe("main"); // untouched
});
