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

test("discovery names a description-only task (manual Refine path) but never a user title", async () => {
  // Description-only capture: the prompt asks for a title and the result applies it.
  const unnamed = createTask(db, { body: "search is slow when the index is cold" });
  const { run, calls } = recordingRunner({
    sufficiency: "ok",
    title: "Speed up cold-index search",
    spec: "Warm the FTS index on boot",
    unknowns: [],
  });
  await runDiscovery(db, unnamed.id, run);
  expect(calls[0]?.prompt).toContain('"title":"string"');
  expect(getTask(db, unnamed.id)?.title).toBe("Speed up cold-index search");

  // User-titled capture: no title asked for, none applied.
  const named = createTask(db, { title: "Keep my wording", body: "details" });
  const second = recordingRunner({ sufficiency: "ok", title: "Agent rename", spec: "x", unknowns: [] });
  await runDiscovery(db, named.id, second.run);
  expect(second.calls[0]?.prompt).not.toContain('"title":"string"');
  expect(getTask(db, named.id)?.title).toBe("Keep my wording");
});

// Real Sonnet frequently returns `spec` as a structured object + `sufficiency:"partial"` — which used
// to crash `specMarkdown` (`j.spec.trim()` on an object), reject runDiscovery, and silently strand the
// task in Refining. It must now render the spec and advance.
test("real-model drift: object `spec` is rendered (was a crash → stuck in Refining)", async () => {
  const task = createTask(db, { title: "Fill optional fields in the modal" });
  const { run } = recordingRunner({
    sufficiency: "partial",
    spec: { summary: "Extend the Add-task modal", current_state: { modal: "title+body only" } },
    unknowns: [],
  });
  const outcome = await runDiscovery(db, task.id, run);
  expect(outcome).toMatchObject({ ran: true, status: "ready" });
  expect(getTask(db, task.id)?.status).toBe("ready");
  expect(readSpec(task.id)).toContain("Extend the Add-task modal"); // object spec rendered, not crashed
});

test("unparseable discovery response → Needs-Feedback with a note (never stranded in Refining)", async () => {
  const task = createTask(db, { title: "vague thing" });
  const run: AgentRunner = async () => ({
    text: "Sorry, here is prose, not JSON.",
    json: undefined,
    costUsd: 0,
    sessionId: "m",
    isError: false,
    raw: {},
  });
  const outcome = await runDiscovery(db, task.id, run);
  expect(outcome).toMatchObject({ ran: true, status: "needs_feedback" });
  expect(getTask(db, task.id)?.status).toBe("needs_feedback");
});
