import type { ServerMessage } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { tasks } from "./db/schema";
import { bootstrap } from "./store/store";
import { createSuggestion, resolveSuggestion } from "./suggestions";
import { buildProposals, emitProposals } from "./proposals";
import { createTask, updateTask } from "./tasks";
import { WsHub } from "./ws";

let db: Db;
let home: string;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-proposals-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("buildProposals nudges on at-risk deadlines, stale tasks, and corrections", () => {
  // at-risk deadline
  const due = createTask(db, { title: "Due" });
  updateTask(db, due.id, { deadline: NOW - DAY });
  // stale task (force old updatedAt)
  const stale = createTask(db, { title: "Stale" });
  db.update(tasks).set({ updatedAt: NOW - 30 * DAY }).where(eq(tasks.id, stale.id)).run();
  // 3 corrections → reflect proposal
  for (let i = 0; i < 3; i++) {
    const s = createSuggestion(db, { entityType: "task", entityId: "t", field: "priority", value: "P2" });
    resolveSuggestion(db, s.id, "override", "P1");
  }

  const kinds = buildProposals(db, NOW).map((p) => p.kind);
  expect(kinds).toContain("deadline");
  expect(kinds).toContain("stale");
  expect(kinds).toContain("reflect");
});

test("buildProposals is empty when nothing is noteworthy", () => {
  createTask(db, { title: "Fresh, no deadline" });
  expect(buildProposals(db, NOW)).toEqual([]);
});

test("emitProposals broadcasts notify once per proposal (deduped)", () => {
  const stale = createTask(db, { title: "Stale" });
  db.update(tasks).set({ updatedAt: NOW - 30 * DAY }).where(eq(tasks.id, stale.id)).run();

  const sent: ServerMessage[] = [];
  const hub = new WsHub();
  hub.broadcast = (m: ServerMessage) => sent.push(m);
  const emitted = new Set<string>();

  const first = emitProposals(db, hub, emitted, NOW);
  expect(first.length).toBe(1);
  expect(sent.filter((m) => m.type === "event" && m.name === "notify")).toHaveLength(1);

  // second call with the same situation → no re-notify
  const second = emitProposals(db, hub, emitted, NOW);
  expect(second).toHaveLength(0);
  expect(sent.filter((m) => m.type === "event" && m.name === "notify")).toHaveLength(1);
});
