import type { ClaudeWindows, UsageStats, UsageWindow } from "@cadence/shared";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "./transcripts";

interface StatsCache {
  lastComputedDate?: string;
  dailyActivity?: Array<{ date: string; messageCount?: number; sessionCount?: number }>;
  dailyModelTokens?: Array<{ date: string; tokensByModel?: Record<string, number> }>;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
  totalSessions?: number;
  totalMessages?: number;
}

function dayTokens(entry: { tokensByModel?: Record<string, number> } | undefined): number {
  if (!entry?.tokensByModel) return 0;
  return Object.values(entry.tokensByModel).reduce((a, b) => a + (b ?? 0), 0);
}

const EMPTY: UsageStats = {
  totalSessions: 0,
  totalMessages: 0,
  lastComputedDate: null,
  recentDay: null,
  week: { messages: 0, sessions: 0, tokens: 0 },
  topModels: [],
};

/** Read ~/.claude/stats-cache.json into an ambient usage summary. */
export function readUsageStats(): UsageStats {
  const file = join(claudeDir(), "stats-cache.json");
  if (!existsSync(file)) return EMPTY;
  let d: StatsCache;
  try {
    d = JSON.parse(readFileSync(file, "utf8")) as StatsCache;
  } catch {
    return EMPTY;
  }

  const activity = d.dailyActivity ?? [];
  const tokens = d.dailyModelTokens ?? [];
  const tokensByDate = new Map(tokens.map((t) => [t.date, dayTokens(t)]));

  const lastActivity = activity[activity.length - 1];
  const recentDay = lastActivity
    ? {
        date: lastActivity.date,
        messages: lastActivity.messageCount ?? 0,
        sessions: lastActivity.sessionCount ?? 0,
        tokens: tokensByDate.get(lastActivity.date) ?? 0,
      }
    : null;

  const week = activity.slice(-7).reduce(
    (acc, a) => ({
      messages: acc.messages + (a.messageCount ?? 0),
      sessions: acc.sessions + (a.sessionCount ?? 0),
      tokens: acc.tokens + (tokensByDate.get(a.date) ?? 0),
    }),
    { messages: 0, sessions: 0, tokens: 0 },
  );

  const topModels = Object.entries(d.modelUsage ?? {})
    .map(([model, m]) => ({ model, tokens: (m.inputTokens ?? 0) + (m.outputTokens ?? 0) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4);

  return {
    totalSessions: d.totalSessions ?? 0,
    totalMessages: d.totalMessages ?? 0,
    lastComputedDate: d.lastComputedDate ?? null,
    recentDay,
    week,
    topModels,
  };
}

// --------------------------------------------------- subscription windows (OAuth usage endpoint)

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const WINDOWS_TTL_MS = 60_000;

/** Pure parser for the OAuth usage payload (✅ verified shape, 2026-06-10):
 *  `{ five_hour: { utilization, resets_at }, seven_day: {...}, seven_day_opus: {...}|null, ... }`. */
export function parseOauthUsage(json: unknown, fetchedAt: number): ClaudeWindows | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  const window = (key: string): UsageWindow | null => {
    const w = raw[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!w || typeof w !== "object") return null;
    if (typeof w.utilization !== "number" || typeof w.resets_at !== "string") return null;
    return { utilization: w.utilization, resetsAt: w.resets_at };
  };
  const fiveHour = window("five_hour");
  const sevenDay = window("seven_day");
  if (!fiveHour && !sevenDay) return null; // unrecognized payload — don't pretend we have data
  return { fiveHour, sevenDay, sevenDayOpus: window("seven_day_opus"), fetchedAt };
}

/** The local Claude Code OAuth access token: ~/.claude/.credentials.json, else the macOS
 *  keychain. Read-only, never logged, never sent to the browser — only the derived
 *  utilization numbers leave the gateway. */
function readOauthToken(): string | null {
  try {
    const file = join(claudeDir(), ".credentials.json");
    if (existsSync(file)) {
      const creds = JSON.parse(readFileSync(file, "utf8")) as {
        claudeAiOauth?: { accessToken?: string };
      };
      if (creds.claudeAiOauth?.accessToken) return creds.claudeAiOauth.accessToken;
    }
  } catch {
    /* fall through to keychain */
  }
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const creds = JSON.parse(out.trim()) as { claudeAiOauth?: { accessToken?: string } };
    return creds.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

let windowsCache: { at: number; value: ClaudeWindows | null } | null = null;

/** Subscription windows (5h + weekly), cached for a minute; null only when no local
 *  Claude Code sign-in exists (or it never worked). A transient fetch failure keeps
 *  serving the last good numbers and retries after the TTL — a blip while the user is
 *  signed in must not masquerade as "signed out".
 *  Skipped under bun test (NODE_ENV=test) — unit tests must not touch keychain/network. */
export async function fetchClaudeWindows(now: number = Date.now()): Promise<ClaudeWindows | null> {
  if (process.env.NODE_ENV === "test") return null;
  if (windowsCache && now - windowsCache.at < WINDOWS_TTL_MS) return windowsCache.value;
  const token = readOauthToken(); // runtime keychain read, never persisted — cadence-allow-secret
  if (!token) {
    windowsCache = { at: now, value: null };
    return null;
  }
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`oauth usage: HTTP ${res.status}`);
    const parsed = parseOauthUsage(await res.json(), now);
    if (!parsed) throw new Error("oauth usage: unrecognized payload");
    windowsCache = { at: now, value: parsed };
    return parsed;
  } catch {
    // Stale-while-error: keep the last good value (possibly null) and retry after TTL.
    windowsCache = { at: now, value: windowsCache?.value ?? null };
    return windowsCache.value;
  }
}
