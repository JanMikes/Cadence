import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import { sessions } from "./db/schema";
import { taskCostUsd } from "./sessions";
import { bootstrap } from "./store/store";
import { createTask, getTaskDetail } from "./tasks";
import { readUsageStats } from "./usage";

let claude: string;
let home: string;
let db: Db;

beforeEach(() => {
  claude = mkdtempSync(join(tmpdir(), "cadence-usage-claude-"));
  home = mkdtempSync(join(tmpdir(), "cadence-usage-home-"));
  process.env.CADENCE_CLAUDE_DIR = claude;
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_CLAUDE_DIR;
  delete process.env.CADENCE_HOME;
  rmSync(claude, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("readUsageStats summarizes stats-cache.json (recent day, week, top models)", () => {
  writeFileSync(
    join(claude, "stats-cache.json"),
    JSON.stringify({
      version: 1,
      lastComputedDate: "2026-06-04",
      totalSessions: 1183,
      totalMessages: 246461,
      dailyActivity: [
        { date: "2026-06-03", messageCount: 100, sessionCount: 3, toolCallCount: 10 },
        { date: "2026-06-04", messageCount: 140, sessionCount: 2, toolCallCount: 31 },
      ],
      dailyModelTokens: [
        { date: "2026-06-03", tokensByModel: { "claude-opus-4-8": 50000 } },
        { date: "2026-06-04", tokensByModel: { "claude-opus-4-8": 93074, "claude-haiku-4-5": 1000 } },
      ],
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 1000, outputTokens: 2000 },
        "claude-haiku-4-5": { inputTokens: 10, outputTokens: 20 },
      },
    }),
  );

  const u = readUsageStats();
  expect(u.totalSessions).toBe(1183);
  expect(u.lastComputedDate).toBe("2026-06-04");
  expect(u.recentDay).toMatchObject({ date: "2026-06-04", messages: 140, sessions: 2, tokens: 94074 });
  expect(u.week.messages).toBe(240); // 100 + 140
  expect(u.week.tokens).toBe(144074); // 50000 + 94074
  expect(u.topModels[0]?.model).toBe("claude-opus-4-8");
});

test("readUsageStats returns zeros when stats-cache.json is missing", () => {
  const u = readUsageStats();
  expect(u.totalSessions).toBe(0);
  expect(u.topModels).toHaveLength(0);
});

test("task cost is the sum of its session costs", () => {
  const task = createTask(db, { title: "Has sessions" });
  for (const cost of [0.01, 0.025]) {
    db.insert(sessions)
      .values({ id: crypto.randomUUID(), taskId: task.id, role: "chat", cwd: "/x", costUsd: cost })
      .run();
  }
  expect(taskCostUsd(db, task.id)).toBeCloseTo(0.035, 4);
  expect(getTaskDetail(db, task.id)?.costUsd).toBeCloseTo(0.035, 4);
});
