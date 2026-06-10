import { afterEach, expect, test } from "bun:test";
import { _clearForgeCache, type CliExec, parseRemote, probeCli, projectForgeStatus } from "./forge";

afterEach(() => _clearForgeCache());

// --- parseRemote matrix (§6.4.a) -------------------------------------------

test("github remotes: https, ssh url, scp-like — with and without .git", () => {
  for (const r of [
    "https://github.com/acme/app.git",
    "https://github.com/acme/app",
    "ssh://git@github.com/acme/app.git",
    "git@github.com:acme/app.git",
    "git@github.com:acme/app",
  ]) {
    const f = parseRemote(r);
    expect(f).toEqual({
      forge: "github",
      host: "github.com",
      owner: "acme",
      repo: "app",
      webUrl: "https://github.com/acme/app",
    });
  }
});

test("gitlab remotes incl. subgroups keep the full group path as owner", () => {
  expect(parseRemote("git@gitlab.com:group/sub/app.git")).toEqual({
    forge: "gitlab",
    host: "gitlab.com",
    owner: "group/sub",
    repo: "app",
    webUrl: "https://gitlab.com/group/sub/app",
  });
  expect(parseRemote("https://gitlab.example.io/team/app.git")?.forge).toBe("gitlab"); // host contains "gitlab"
});

test("self-hosted on a custom domain: null without an override, classified with one", () => {
  const bare = parseRemote("git@code.acme.dev:platform/app.git");
  expect(bare?.forge).toBeNull();
  expect(bare?.owner).toBe("platform");
  const overridden = parseRemote("git@code.acme.dev:platform/app.git", "gitlab");
  expect(overridden?.forge).toBe("gitlab");
  expect(overridden?.webUrl).toBe("https://code.acme.dev/platform/app");
});

test("garbage, empty and ownerless remotes parse to null", () => {
  expect(parseRemote(null)).toBeNull();
  expect(parseRemote("")).toBeNull();
  expect(parseRemote("   ")).toBeNull();
  expect(parseRemote("not a remote at all")).toBeNull();
  expect(parseRemote("https://github.com/justonepart")).toBeNull();
});

// --- CLI probe (§6.4.b, mocked exec) ----------------------------------------

const ghExec: CliExec = (cmd, args) => {
  if (args[0] === "--version") return "gh version 2.62.0 (2026-01-15)\n";
  if (args[0] === "auth") return "github.com\n  ✓ Logged in to github.com account janmikes (keyring)\n";
  throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
};

test("probeCli: installed + authenticated + account parsed (gh wording)", () => {
  const s = probeCli("gh", undefined, ghExec);
  expect(s).toEqual({
    cli: "gh",
    installed: true,
    version: "gh version 2.62.0 (2026-01-15)",
    authenticated: true,
    account: "janmikes",
  });
});

test("probeCli: glab wording ('as <user>'), unauthenticated, and missing binary", () => {
  const glabExec: CliExec = (_c, args) =>
    args[0] === "--version" ? "glab 1.50.0\n" : "gitlab.com\n  ✓ Logged in to gitlab.com as janmikes\n";
  expect(probeCli("glab", undefined, glabExec).account).toBe("janmikes");

  const noAuth: CliExec = (_c, args) =>
    args[0] === "--version" ? "gh version 2.0.0\n" : "You are not logged into any GitHub hosts.\n";
  const s = probeCli("gh", undefined, noAuth);
  expect(s.installed).toBe(true);
  expect(s.authenticated).toBe(false);

  const missing: CliExec = () => {
    const err = new Error("spawn gh ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  };
  expect(probeCli("gh", undefined, missing)).toEqual({
    cli: "gh",
    installed: false,
    version: null,
    authenticated: false,
    account: null,
  });
});

test("projectForgeStatus: probes the matching CLI, caches, and refresh busts the cache", () => {
  let calls = 0;
  const exec: CliExec = (cmd, args) => {
    calls += 1;
    if (args[0] === "--version") return `${cmd} version 1.0.0\n`;
    return "Logged in to github.com account janmikes\n";
  };

  const first = projectForgeStatus("git@github.com:acme/app.git", null, { exec });
  expect(first.remote?.forge).toBe("github");
  expect(first.cli?.cli).toBe("gh");
  expect(first.cli?.authenticated).toBe(true);
  const callsAfterFirst = calls;

  projectForgeStatus("git@github.com:acme/app.git", null, { exec });
  expect(calls).toBe(callsAfterFirst); // cached — no extra shelling

  projectForgeStatus("git@github.com:acme/app.git", null, { exec, refresh: true });
  expect(calls).toBeGreaterThan(callsAfterFirst); // refresh re-probes

  // no forge → no CLI probe at all
  const none = projectForgeStatus("git@code.acme.dev:x/y.git", null, { exec: () => "never" });
  expect(none.remote?.forge).toBeNull();
  expect(none.cli).toBeNull();
});
