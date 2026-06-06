import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { computeSelfMonitor } from "./selfmonitor";
import { bootstrap, writeVerify } from "./store/store";
import { createSuggestion, resolveSuggestion } from "./suggestions";
import { createTask } from "./tasks";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-selfmon-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("provenance counts + acceptance rate from suggestion resolutions", () => {
  const mk = () => createSuggestion(db, { entityType: "task", entityId: "t", field: "priority", value: "P2" });
  resolveSuggestion(db, mk().id, "accept");
  resolveSuggestion(db, mk().id, "accept");
  resolveSuggestion(db, mk().id, "override", "P1");
  mk(); // left open (suggested)

  const m = computeSelfMonitor(db);
  expect(m.provenance.confirmed).toBe(2);
  expect(m.provenance.overridden).toBe(1);
  expect(m.provenance.suggested).toBe(1);
  expect(m.acceptanceRate).toBeCloseTo(2 / 3, 5); // 2 confirmed of 3 resolved
});

test("verify pass-rate from recorded verify.md outcomes", () => {
  const a = createTask(db, { title: "A" });
  const b = createTask(db, { title: "B" });
  writeVerify(a.id, { passed: true, criteria: [], checks: [], issues: [] });
  writeVerify(b.id, { passed: false, criteria: [], checks: [], issues: [] });

  const m = computeSelfMonitor(db);
  expect(m.verify.passed).toBe(1);
  expect(m.verify.failed).toBe(1);
  expect(m.verify.passRate).toBeCloseTo(0.5, 5);
});

test("empty state yields null rates, zero counts", () => {
  const m = computeSelfMonitor(db);
  expect(m.acceptanceRate).toBeNull();
  expect(m.verify.passRate).toBeNull();
  expect(m.rollovers).toBe(0);
  expect(m.staleTasks).toBe(0);
});
