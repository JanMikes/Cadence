import type { UsageStats } from "@cadence/shared";
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
