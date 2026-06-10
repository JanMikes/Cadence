import { execFileSync } from "node:child_process";
import type { ForgeCliStatus, ForgeInfo, ForgeKind } from "@cadence/shared";

/**
 * Forge detection (plan §6.4) — understand whether a project lives on GitHub or
 * GitLab and whether the matching CLI (`gh` / `glab`) is installed + authenticated,
 * so delivery, context injection and the review module (6.5) can use it.
 * Detection never assumes: unknown hosts stay `forge: null` unless the project's
 * `forgeOverride` says otherwise (self-hosted instances).
 */

/** Split a git remote into host + path. Handles https/ssh URLs and scp-like syntax. */
function splitRemote(remote: string): { host: string; path: string } | null {
  // https://host/owner/repo(.git) · ssh://git@host[:port]/owner/repo(.git) · git://…
  const url = remote.match(/^(?:https?|ssh|git):\/\/(?:[\w.~-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/);
  if (url) return { host: url[1] as string, path: url[2] as string };
  // scp-like: git@host:owner/repo(.git)
  const scp = remote.match(/^(?:[\w.~-]+@)?([\w.-]+):([^/].*)$/);
  if (scp) return { host: scp[1] as string, path: scp[2] as string };
  return null;
}

/**
 * Parse a git remote URL into forge/host/owner/repo. GitLab subgroups keep their
 * full path as `owner` ("group/subgroup"). `override` wins over the host heuristic
 * (self-hosted GitLab on a custom domain, say).
 */
export function parseRemote(
  remote: string | null | undefined,
  override: ForgeKind | null = null,
): ForgeInfo | null {
  const trimmed = remote?.trim();
  if (!trimmed) return null;
  const parts = splitRemote(trimmed);
  if (!parts) return null;
  const segments = parts.path
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1] as string;
  const owner = segments.slice(0, -1).join("/");
  const host = parts.host;
  const h = host.toLowerCase();
  const forge: ForgeKind | null =
    override ?? (h.includes("github") ? "github" : h.includes("gitlab") ? "gitlab" : null);
  return { forge, host, owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
}

// ---------------------------------------------------------------- CLI probing

/** Shell-out seam, injectable for deterministic tests. Returns stdout+stderr or throws. */
export type CliExec = (cmd: string, args: string[]) => string;

const realExec: CliExec = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // `gh auth status` exits 1 when unauthenticated but still prints useful output —
    // surface it instead of throwing, and rethrow only when the binary is missing.
    const e = err as { code?: string; stdout?: unknown; stderr?: unknown };
    if (e.code === "ENOENT") throw err;
    return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
};

/** Probe one CLI: installed (version), authenticated, account login when detectable. */
export function probeCli(cli: "gh" | "glab", host?: string, exec: CliExec = realExec): ForgeCliStatus {
  let version: string | null = null;
  try {
    const out = exec(cli, ["--version"]);
    version = out.trim().split("\n")[0]?.trim() || null;
  } catch {
    return { cli, installed: false, version: null, authenticated: false, account: null };
  }

  let authenticated = false;
  let account: string | null = null;
  try {
    const args = ["auth", "status", ...(host ? ["--hostname", host] : [])];
    const out = exec(cli, args);
    authenticated = /logged in to/i.test(out);
    // ⚠ text parsing (no stable JSON output): gh prints "Logged in to <host> account <user>",
    // glab prints "Logged in to <host> as <user>". Account stays null when the wording drifts —
    // authentication detection is the load-bearing part.
    account =
      out.match(/account\s+(\S+)/i)?.[1]?.replace(/\(.*$/, "").trim() ||
      out.match(/\bas\s+(\S+)/i)?.[1]?.trim() ||
      null;
  } catch {
    authenticated = false;
  }
  return { cli, installed: true, version, authenticated, account };
}

export interface ForgeProbeResult {
  remote: ForgeInfo | null;
  cli: ForgeCliStatus | null;
  probedAt: number;
}

// Probes shell out twice per CLI — cache briefly so list views don't hammer them.
const PROBE_TTL_MS = 10 * 60_000;
const probeCache = new Map<string, ForgeProbeResult>();

/**
 * The forge status for a project: parsed remote + the matching CLI's capability.
 * Cached for 10 min per (remote, override); `refresh` busts the cache (the UI button).
 */
export function projectForgeStatus(
  gitRemote: string | null | undefined,
  override: ForgeKind | null = null,
  opts: { refresh?: boolean; exec?: CliExec; now?: () => number } = {},
): ForgeProbeResult {
  const now = opts.now ?? Date.now;
  const key = `${gitRemote ?? ""}|${override ?? ""}`;
  const cached = probeCache.get(key);
  if (!opts.refresh && cached && now() - cached.probedAt < PROBE_TTL_MS) return cached;

  const remote = parseRemote(gitRemote, override);
  let cli: ForgeCliStatus | null = null;
  if (remote?.forge === "github") {
    cli = probeCli("gh", remote.host === "github.com" ? undefined : remote.host, opts.exec);
  } else if (remote?.forge === "gitlab") {
    cli = probeCli("glab", remote.host === "gitlab.com" ? undefined : remote.host, opts.exec);
  }
  const result: ForgeProbeResult = { remote, cli, probedAt: now() };
  probeCache.set(key, result);
  return result;
}

/** Test-only: drop the probe cache. */
export function _clearForgeCache(): void {
  probeCache.clear();
}
