import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "../db/client";
import { bootstrap, readSpec } from "../store/store";
import { createTask, getTask } from "../tasks";
import type { AgentRunOptions } from "./runner";
import { buildDiscoveryPrompt, runDiscovery, specMarkdown } from "./discovery";
import type { AgentRunner } from "./triage";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-disc-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** Mock runner that records the opts it was called with and returns fixed JSON. */
function recordingRunner(json: object): { run: AgentRunner; calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  const run: AgentRunner = async (opts) => {
    calls.push(opts);
    const result: AgentResult = {
      text: JSON.stringify(json),
      json,
      costUsd: 0.001,
      sessionId: "mock",
      isError: false,
      raw: {},
    };
    return result;
  };
  return { run, calls };
}

test("buildDiscoveryPrompt references the explorer subagents + the task", () => {
  const p = buildDiscoveryPrompt({ title: "Add search", body: "FTS over notes" });
  expect(p).toContain("Add search");
  expect(p).toContain("explorer");
  expect(p).toContain("acceptanceCriteria");
});

test("specMarkdown renders scope/approaches/criteria/unknowns", () => {
  const md = specMarkdown({
    spec: "Build X",
    scope: { in: ["a"], out: ["b"] },
    acceptanceCriteria: ["tests pass"],
    unknowns: ["which db?"],
    approaches: [{ name: "opt1", summary: "do it", recommended: true }],
  });
  expect(md).toContain("# Spec");
  expect(md).toContain("- [ ] tests pass");
  expect(md).toContain("opt1");
  expect(md).toContain("(recommended)");
  expect(md).toContain("which db?");
});

test("sufficient discovery with no unknowns → Ready + spec.md written; explorers injected", async () => {
  const task = createTask(db, { title: "Add a health endpoint" });
  const { run, calls } = recordingRunner({
    sufficiency: "ok",
    spec: "Add GET /health returning 200",
    acceptanceCriteria: ["curl /health is 200"],
    unknowns: [],
  });

  const outcome = await runDiscovery(db, task.id, run);
  expect(outcome).toMatchObject({ ran: true, status: "ready" });
  expect(getTask(db, task.id)?.status).toBe("ready");
  expect(readSpec(task.id)).toContain("Add GET /health");

  // the explorer subagents were injected via --agents
  const agentsJson = calls[0]?.agentsJson ?? "{}";
  expect(Object.keys(JSON.parse(agentsJson))).toContain("explorer");
});

test("sufficient discovery WITH unknowns stays in Refining (Questioner handles them next)", async () => {
  const task = createTask(db, { title: "Migrate the store" });
  const { run } = recordingRunner({ sufficiency: "ok", spec: "Migrate", unknowns: ["which target db?"] });
  const outcome = await runDiscovery(db, task.id, run);
  expect(outcome.status).toBe("refining");
  expect(readSpec(task.id)).toContain("which target db?");
});

test("insufficient discovery → Needs-Feedback", async () => {
  const task = createTask(db, { title: "do something" });
  const { run } = recordingRunner({ sufficiency: "insufficient", needFromUser: "What should it do?" });
  const outcome = await runDiscovery(db, task.id, run);
  expect(outcome.status).toBe("needs_feedback");
  expect(getTask(db, task.id)?.status).toBe("needs_feedback");
});
