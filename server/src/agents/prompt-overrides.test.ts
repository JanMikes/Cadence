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

test("one-shot stages receive the composed context layers (§6.3.f)", async () => {
  const { createProject } = await import("../projects");
  const { updateTask } = await import("../tasks");
  const db: Db = openDb(join(home, "ctx.db"));
  migrateDb(db);

  const project = createProject(db, {
    name: "Ctx Proj",
    rootPath: "/tmp/ctx",
    systemPrompt: "ALWAYS USE TABS IN THIS PROJECT",
  });
  const t = createTask(db, { title: "context flows" });
  updateTask(db, t.id, { project: project.slug });

  const seen: Array<{ role?: string; appendSystemPrompt?: string }> = [];
  const run = makeRecordingRunner({
    db,
    hub: new WsHub(),
    base: async (opts) => {
      seen.push({ role: opts.role, appendSystemPrompt: opts.appendSystemPrompt });
      return { text: "{}", json: {}, costUsd: 0, sessionId: null, isError: false, raw: {} };
    },
  });

  await run({ cwd: "/tmp/ctx", role: "discovery", prompt: "p", taskId: t.id });
  await run({ cwd: "/tmp/ctx", role: "delivery", prompt: "p", taskId: t.id });

  for (const call of seen) {
    expect(call.appendSystemPrompt ?? "").toContain("ALWAYS USE TABS IN THIS PROJECT");
    expect(call.appendSystemPrompt ?? "").toContain("Project: Ctx Proj");
  }

  // an explicit caller value always wins over composition
  await run({ cwd: "/tmp/ctx", role: "verifier", prompt: "p", taskId: t.id, appendSystemPrompt: "EXPLICIT" });
  expect(seen[2]?.appendSystemPrompt).toBe("EXPLICIT");
});

test("composed context carries the forge capability line (§6.4.f)", async () => {
  const { createProject } = await import("../projects");
  const { updateTask } = await import("../tasks");
  const { composeContext } = await import("../context");
  const { projectForgeStatus, _clearForgeCache } = await import("../forge");
  const db: Db = openDb(join(home, "forgectx.db"));
  migrateDb(db);

  const project = createProject(db, {
    name: "Forge Ctx",
    rootPath: "/tmp/fc",
    gitRemote: "git@github.com:acme/fc.git",
  });
  const t = createTask(db, { title: "uses gh" });
  updateTask(db, t.id, { project: project.slug });

  // Pre-warm the probe cache with a deterministic fake so composeContext never shells out.
  _clearForgeCache();
  projectForgeStatus("git@github.com:acme/fc.git", null, {
    exec: (cmd, args) =>
      args[0] === "--version" ? `${cmd} version 1\n` : "Logged in to github.com account janmikes\n",
  });

  const projectId = (await import("../projects")).getProject(db, project.slug)?.id ?? null;
  const ctx = composeContext(db, { taskId: t.id, projectId, fleetId: null });
  expect(ctx).toContain("Repository forge");
  expect(ctx).toContain("github.com/acme/fc (GitHub)");
  expect(ctx).toContain("`gh` CLI is installed and authenticated");
  _clearForgeCache();
});
