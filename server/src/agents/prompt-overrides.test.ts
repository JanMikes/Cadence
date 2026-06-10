import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { listTaskSessions } from "../sessions";
import { bootstrap, readSettings, writeSettings } from "../store/store";
import { createTask } from "../tasks";
import { WsHub } from "../ws";
import { buildDiscoveryPrompt } from "./discovery";
import { agentsJson } from "./library";
import { AGENT_PROMPTS, getAgentModel, getAgentPrompt } from "./prompts";
import { makeRecordingRunner } from "./recording-runner";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-ovr-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function setOverride(role: string, o: { prompt?: string; model?: string }): void {
  const s = readSettings();
  writeSettings({ ...s, agents: { ...(s.agents ?? {}), [role]: o } });
}

test("getAgentPrompt: override wins; removing it restores the byte-identical default (§6.3.b)", () => {
  const fallback = AGENT_PROMPTS.discovery?.defaultTemplate ?? "";
  expect(getAgentPrompt("discovery")).toBe(fallback);

  setOverride("discovery", { prompt: "Custom discovery for {{title}}\n{{bodyLine}}" });
  expect(getAgentPrompt("discovery")).toBe("Custom discovery for {{title}}\n{{bodyLine}}");

  // builders render THROUGH the override — variables still substitute
  const built = buildDiscoveryPrompt({ title: "Add SSO", body: "" });
  expect(built).toBe("Custom discovery for Add SSO"); // empty bodyLine line drops

  const s = readSettings();
  writeSettings({ ...s, agents: {} });
  expect(getAgentPrompt("discovery")).toBe(fallback); // reset = default again
});

test("getAgentModel: override > registry default; unknown roles fall through (§6.3.b)", () => {
  expect(getAgentModel("discovery")).toBe("claude-sonnet-4-6");
  setOverride("discovery", { model: "claude-opus-4-8" });
  expect(getAgentModel("discovery")).toBe("claude-opus-4-8");
  expect(getAgentModel("implementer")).toBe("claude-opus-4-8"); // untouched default
  expect(getAgentModel("chat")).toBeUndefined();
  expect(getAgentModel(undefined)).toBeUndefined();
});

test("a model override reaches the recorded session row (the spawn resolution chain)", async () => {
  const db: Db = openDb(join(home, "cadence.db"));
  migrateDb(db);
  setOverride("triage", { model: "claude-opus-4-8" });

  const t = createTask(db, { title: "model override" });
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async () => ({ text: "{}", json: {}, costUsd: 0, sessionId: null, isError: false, raw: {} }),
  });
  await run({ cwd: "/tmp/p", role: "triage", prompt: "p", taskId: t.id });

  expect(listTaskSessions(db, t.id)[0]?.model).toBe("claude-opus-4-8");
});

test("subagent overrides resolve lazily — agentsJson picks them up per call (§6.3.b)", () => {
  expect(agentsJson(["explorer"])).toContain("read-only code explorer"); // default
  setOverride("subagent:explorer", { prompt: "You are a SPELUNKER." });
  const json = JSON.parse(agentsJson(["explorer"])) as Record<string, { prompt: string }>;
  expect(json.explorer?.prompt).toBe("You are a SPELUNKER.");
});

test("an empty/whitespace prompt override falls back to the default (never an empty prompt)", () => {
  setOverride("planner", { prompt: "   \n  " });
  expect(getAgentPrompt("planner")).toBe(AGENT_PROMPTS.planner?.defaultTemplate ?? "");
});
