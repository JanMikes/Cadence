import { expect, test } from "bun:test";
import type { ProjectForgeStatus } from "@cadence/shared";
import { forgeSummary } from "./Projects";

function status(over: Partial<ProjectForgeStatus> = {}): ProjectForgeStatus {
  return {
    remote: {
      forge: "github",
      host: "github.com",
      owner: "acme",
      repo: "widget",
      webUrl: "https://github.com/acme/widget",
    },
    cli: { cli: "gh", installed: true, version: "gh 2.62.0", authenticated: true, account: "janmikes" },
    probedAt: 1,
    ...over,
  };
}

test("GitHub project: badge + authenticated gh line (§6.4.c)", () => {
  const s = forgeSummary(status());
  expect(s.badge).toBe("GitHub · acme/widget");
  expect(s.cliLine).toBe("✓ gh authenticated as @janmikes");
  expect(s.hint).toBeNull();
  expect(s.webUrl).toBe("https://github.com/acme/widget");
});

test("GitLab project: glab status incl. not-installed and not-signed-in hints", () => {
  const gl = status({
    remote: { forge: "gitlab", host: "gitlab.com", owner: "grp/sub", repo: "app", webUrl: "https://gitlab.com/grp/sub/app" },
    cli: { cli: "glab", installed: false, version: null, authenticated: false, account: null },
  });
  const missing = forgeSummary(gl);
  expect(missing.badge).toBe("GitLab · grp/sub/app");
  expect(missing.cliLine).toBe("✗ glab is not installed");
  expect(missing.hint).toContain("brew install glab");

  const unauth = forgeSummary(
    status({ cli: { cli: "glab", installed: true, version: "glab 1.50", authenticated: false, account: null } }),
  );
  expect(unauth.cliLine).toBe("✗ glab installed but not signed in");
  expect(unauth.hint).toContain("glab auth login");
});

test("unrecognized host: badge falls back to the host + override hint, no CLI line", () => {
  const s = forgeSummary(
    status({
      remote: { forge: null, host: "code.acme.dev", owner: "platform", repo: "app", webUrl: "https://code.acme.dev/platform/app" },
      cli: null,
    }),
  );
  expect(s.badge).toBe("code.acme.dev · platform/app");
  expect(s.cliLine).toBeNull();
  expect(s.hint).toContain("self-hosted");
});

test("no remote / no data → all-null summary", () => {
  expect(forgeSummary(undefined)).toEqual({ badge: null, webUrl: null, cliLine: null, hint: null });
});
