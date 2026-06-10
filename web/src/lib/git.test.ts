import type { TaskGitContext } from "@cadence/shared";
import { expect, test } from "bun:test";
import { gitStateLabel, gitStateTone } from "./git";

const ctx = (over: Partial<TaskGitContext> = {}): TaskGitContext => ({
  kind: "branch",
  branch: "cadence/fix-auth-3f2a1b9c",
  baseBranch: "main",
  deliveryCommit: "abc123",
  merged: "unmerged",
  mergedVia: null,
  checkedAt: 1,
  ...over,
});

test("gitStateLabel speaks plain language for every state", () => {
  expect(gitStateLabel(ctx({ kind: "direct" }))).toBe("Committed directly to main");
  expect(gitStateLabel(ctx({ kind: "direct", baseBranch: null }))).toBe("Committed directly");
  expect(gitStateLabel(ctx({ merged: "merged", mergedVia: "cadence" }))).toBe(
    "Merged into main via Cadence",
  );
  expect(gitStateLabel(ctx({ merged: "merged", mergedVia: "forge" }))).toBe(
    "Merged into main via the PR/MR",
  );
  expect(gitStateLabel(ctx({ merged: "merged", mergedVia: "external" }))).toBe(
    "Merged into main outside Cadence",
  );
  expect(gitStateLabel(ctx())).toBe("Not merged yet");
  expect(gitStateLabel(ctx({ merged: "branch_gone" }))).toBe(
    "Branch gone — possibly squash-merged",
  );
  expect(gitStateLabel(ctx({ merged: "unknown" }))).toBe("Merge state unknown");
});

test("gitStateTone: shipped = ok, needs-attention = warn, unknown = muted", () => {
  expect(gitStateTone(ctx({ kind: "direct" }))).toBe("ok");
  expect(gitStateTone(ctx({ merged: "merged" }))).toBe("ok");
  expect(gitStateTone(ctx())).toBe("warn");
  expect(gitStateTone(ctx({ merged: "branch_gone" }))).toBe("warn");
  expect(gitStateTone(ctx({ merged: "unknown" }))).toBe("muted");
});
