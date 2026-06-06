import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { readGlobalMemory } from "../memory";
import { bootstrap } from "../store/store";
import { createSuggestion, resolveSuggestion } from "../suggestions";
import { applyReflection, buildReflectorPrompt, gatherSignals, runReflector } from "./reflector";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-reflector-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function correction() {
  const s = createSuggestion(db, { entityType: "task", entityId: "t1", field: "priority", value: "P2" });
  resolveSuggestion(db, s.id, "override", "P1"); // I bumped it up — a correction signal
  return s;
}

test("gatherSignals surfaces resolved corrections, not open suggestions", () => {
  createSuggestion(db, { entityType: "task", entityId: "t0", field: "labels", value: ["x"] }); // open
  correction();
  const signals = gatherSignals(db);
  expect(signals.length).toBe(1);
  expect(signals[0]).toContain("overridden task.priority");
});

test("applyReflection appends lessons to global memory", () => {
  const n = applyReflection(db, { lessons: [{ scope: "global", note: "Jan trims priorities up by one" }] });
  expect(n).toBe(1);
  expect(readGlobalMemory()).toContain("trims priorities up by one");
});

test("runReflector bails when there are no signals", async () => {
  const outcome = await runReflector(db, () =>
    Promise.resolve({ text: "{}", json: {}, costUsd: 0, sessionId: "s", isError: false, raw: {} }),
  );
  expect(outcome.ran).toBe(false);
});

test("runReflector distills signals → memory via the (mock) agent", async () => {
  correction();
  let sawPrompt = "";
  const mock = (opts: { prompt: string }): Promise<AgentResult> => {
    sawPrompt = opts.prompt;
    return Promise.resolve({
      text: "x",
      json: { lessons: [{ scope: "global", note: "Recalibrate priority suggestions upward" }] },
      costUsd: 0,
      sessionId: "s",
      isError: false,
      raw: {},
    });
  };
  const outcome = await runReflector(db, mock as never);
  expect(outcome).toEqual({ ran: true, lessons: 1 });
  expect(sawPrompt).toContain("overridden task.priority"); // signal reached the prompt
  expect(readGlobalMemory()).toContain("Recalibrate priority suggestions upward");
});

test("buildReflectorPrompt lists the signals + asks for durable lessons only", () => {
  const p = buildReflectorPrompt(["overridden task.priority = P1"]);
  expect(p).toContain("DURABLE");
  expect(p).toContain("overridden task.priority");
});
