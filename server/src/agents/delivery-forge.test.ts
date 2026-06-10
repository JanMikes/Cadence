import { afterEach, expect, test } from "bun:test";
import type { CliExec } from "../forge";
import { _clearForgeCache } from "../forge";
import { openPrForProject, type ShellRunner } from "./delivery";

afterEach(() => _clearForgeCache());

const authedCli: CliExec = (cmd, args) =>
  args[0] === "--version"
    ? `${cmd} version 9.9.9\n`
    : `Logged in to whatever account janmikes\n`;

function recordingShell(failOn?: string): { shell: ShellRunner; calls: string[][] } {
  const calls: string[][] = [];
  const shell: ShellRunner = (cmd) => {
    calls.push(cmd);
    if (failOn && cmd[0] === failOn) return { ok: false, stdout: "", stderr: `${failOn} exploded` };
    if (cmd[0] === "gh") return { ok: true, stdout: "https://github.com/acme/app/pull/7\n", stderr: "" };
    if (cmd[0] === "glab") return { ok: true, stdout: "https://gitlab.com/grp/app/-/merge_requests/3\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" }; // git push
  };
  return { shell, calls };
}

test("github project: pushes, runs `gh pr create`, captures the PR url (§6.4.d)", () => {
  const { shell, calls } = recordingShell();
  const attempt = openPrForProject(
    { gitRemote: "git@github.com:acme/app.git", forgeOverride: null },
    "/tmp/repo",
    "cadence/fix-1",
    { shell, probeExec: authedCli },
  );
  expect(attempt).toEqual({ url: "https://github.com/acme/app/pull/7", fellBack: false, note: null });
  expect(calls[0]).toEqual(["git", "push", "-u", "origin", "cadence/fix-1"]);
  expect(calls[1]?.slice(0, 3)).toEqual(["gh", "pr", "create"]);
});

test("gitlab project: runs `glab mr create --source-branch …` and captures the MR url", () => {
  const { shell, calls } = recordingShell();
  const attempt = openPrForProject(
    { gitRemote: "git@gitlab.com:grp/app.git", forgeOverride: null },
    "/tmp/repo",
    "cadence/fix-2",
    { shell, probeExec: authedCli },
  );
  expect(attempt.url).toBe("https://gitlab.com/grp/app/-/merge_requests/3");
  expect(calls[1]?.[0]).toBe("glab");
  expect(calls[1]).toContain("--source-branch");
});

test("fallbacks: no forge / CLI missing / unauthenticated / push failure — never a hard fail", () => {
  // no forge remote
  const none = openPrForProject(
    { gitRemote: "git@code.acme.dev:x/y.git", forgeOverride: null },
    "/t",
    "b",
    { shell: recordingShell().shell, probeExec: authedCli },
  );
  expect(none.fellBack).toBe(true);
  expect(none.note).toContain("no GitHub/GitLab remote");

  // CLI missing
  const missingExec: CliExec = () => {
    const err = new Error("ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  };
  const missing = openPrForProject(
    { gitRemote: "git@gitlab.com:g/a.git", forgeOverride: null },
    "/t",
    "b",
    { shell: recordingShell().shell, probeExec: missingExec },
  );
  expect(missing.fellBack).toBe(true);
  expect(missing.note).toContain("brew install glab");

  // installed but not signed in
  _clearForgeCache();
  const unauthExec: CliExec = (_c, args) =>
    args[0] === "--version" ? "gh version 1\n" : "not logged in\n";
  const unauth = openPrForProject(
    { gitRemote: "git@github.com:a/b.git", forgeOverride: null },
    "/t",
    "b",
    { shell: recordingShell().shell, probeExec: unauthExec },
  );
  expect(unauth.fellBack).toBe(true);
  expect(unauth.note).toContain("gh auth login");

  // push failure
  _clearForgeCache();
  const { shell } = recordingShell("git");
  const pushFail = openPrForProject(
    { gitRemote: "git@github.com:a/b.git", forgeOverride: null },
    "/t",
    "b",
    { shell, probeExec: authedCli },
  );
  expect(pushFail.fellBack).toBe(true);
  expect(pushFail.note).toContain("push failed");
});

test("forgeOverride classifies a self-hosted host so the MR flow runs", () => {
  const { shell, calls } = recordingShell();
  const attempt = openPrForProject(
    { gitRemote: "git@code.acme.dev:platform/app.git", forgeOverride: "gitlab" },
    "/t",
    "b",
    { shell, probeExec: authedCli },
  );
  expect(attempt.url).toContain("merge_requests");
  expect(calls[1]?.[0]).toBe("glab");
});
