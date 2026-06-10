import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStageTimeoutMs } from "./agents/runner";
import { OPS_DEFAULTS, opsSettings, stuckIdleMs } from "./ops";
import { bootstrap, readSettings, writeSettings } from "./store/store";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-ops-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  delete process.env.CADENCE_SESSION_STUCK_MS;
  rmSync(home, { recursive: true, force: true });
});

function setOps(operations: Record<string, number>): void {
  writeSettings({ ...readSettings(), operations });
}

test("opsSettings: defaults apply; overrides win; invalid values are ignored (§6.3.e)", () => {
  expect(opsSettings()).toEqual(OPS_DEFAULTS);

  setOps({ maxStageAttemptsPer24h: 5, stuckThresholdMinutes: 3 });
  const ops = opsSettings();
  expect(ops.maxStageAttemptsPer24h).toBe(5);
  expect(ops.stuckThresholdMinutes).toBe(3);
  expect(ops.maxConcurrentAgents).toBe(OPS_DEFAULTS.maxConcurrentAgents); // untouched

  setOps({ maxConcurrentAgents: -2, readStageTimeoutMinutes: Number.NaN });
  expect(opsSettings().maxConcurrentAgents).toBe(OPS_DEFAULTS.maxConcurrentAgents);
  expect(opsSettings().readStageTimeoutMinutes).toBe(OPS_DEFAULTS.readStageTimeoutMinutes);
});

test("stuckIdleMs: settings knob applies; the env var stays the strongest override", () => {
  expect(stuckIdleMs()).toBe(10 * 60_000);
  setOps({ stuckThresholdMinutes: 2 });
  expect(stuckIdleMs()).toBe(2 * 60_000);
  process.env.CADENCE_SESSION_STUCK_MS = "5000";
  expect(stuckIdleMs()).toBe(5000);
});

test("defaultStageTimeoutMs reads the live knobs (§6.3.e wires §6.1.g)", () => {
  expect(defaultStageTimeoutMs("discovery")).toBe(15 * 60_000);
  expect(defaultStageTimeoutMs("implementer")).toBe(60 * 60_000);
  setOps({ readStageTimeoutMinutes: 1, implementStageTimeoutMinutes: 2 });
  expect(defaultStageTimeoutMs("discovery")).toBe(60_000);
  expect(defaultStageTimeoutMs("verifier")).toBe(120_000);
});
