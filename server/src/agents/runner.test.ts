import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStageTimeoutMs, modelForRole, parseAgentJson, runAgent } from "./runner";

const MOCK_CMD = [process.execPath, join(import.meta.dir, "..", "testing", "mock-agent.ts")];

afterEach(() => {
  delete process.env.CADENCE_MOCK_AGENT_RESULT;
  delete process.env.CADENCE_MOCK_AGENT_ASK;
  delete process.env.CADENCE_MOCK_AGENT_DENIALS;
});

test("modelForRole maps roles to default models", () => {
  expect(modelForRole("triage")).toBe("claude-haiku-4-5");
  expect(modelForRole("discovery")).toBe("claude-sonnet-4-6");
  expect(modelForRole("implementer")).toBe("claude-opus-4-8");
  expect(modelForRole("chat")).toBeUndefined();
});

test("parseAgentJson handles raw + fenced JSON, returns null for prose", () => {
  expect(parseAgentJson('{"a":1}')).toEqual({ a: 1 });
  expect(parseAgentJson('```json\n{"b":2}\n```')).toEqual({ b: 2 });
  expect(parseAgentJson("just some prose")).toBeNull();
});

test("runAgent runs the one-shot worker and parses result + cost + session", async () => {
  const res = await runAgent({ cwd: tmpdir(), role: "triage", prompt: "hello", command: MOCK_CMD });
  expect(res.text).toBe("echo: hello");
  expect(res.costUsd).toBeCloseTo(0.002, 4);
  expect(res.sessionId).toBe("mock-agent-session");
  expect(res.isError).toBe(false);
});

test("runAgent surfaces structured JSON the agent returns", async () => {
  process.env.CADENCE_MOCK_AGENT_RESULT = JSON.stringify({ project: "acme", priority: "high" });
  const res = await runAgent({ cwd: tmpdir(), role: "triage", prompt: "triage this", command: MOCK_CMD });
  expect(res.json).toEqual({ project: "acme", priority: "high" });
});

test("runAgent streams events live (onEvent) and reports the child pid (onSpawn)", async () => {
  process.env.CADENCE_MOCK_AGENT_STREAM = "1";
  try {
    const types: string[] = [];
    let pid: number | null = null;
    const res = await runAgent({
      cwd: tmpdir(),
      role: "implementer",
      prompt: "build it",
      command: MOCK_CMD,
      onSpawn: (p) => {
        pid = p;
      },
      onEvent: (ev) => types.push(ev.type),
    });

    expect(pid).toBeGreaterThan(0); // child pid delivered right after spawn
    // the full stream arrived in order, ending with the result event
    expect(types[0]).toBe("system");
    expect(types).toContain("stream_event");
    expect(types).toContain("assistant");
    expect(types[types.length - 1]).toBe("result");
    // …and the final AgentResult still parses from the result event
    expect(res.text).toBe("echo: build it");
    expect(res.costUsd).toBeCloseTo(0.002, 4);
    expect(res.isError).toBe(false);
  } finally {
    delete process.env.CADENCE_MOCK_AGENT_STREAM;
  }
});

test("runAgent spawns the child as its own process-group leader (§6.1.e) so kill(-pid) reaps the tree", async () => {
  const { execFileSync } = await import("node:child_process");
  let pid: number | null = null;
  const done = runAgent({
    cwd: tmpdir(),
    role: "implementer",
    prompt: "x",
    // a stand-in long-running child; extra claude args land in $0/$@ and are ignored
    command: ["bash", "-c", "sleep 30"],
    onSpawn: (p) => {
      pid = p;
    },
  });
  await new Promise((r) => setTimeout(r, 150)); // let it spawn
  expect(pid).not.toBeNull();
  const pgid = Number(execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }).trim());
  expect(pgid).toBe(pid as unknown as number); // group leader == its own pid
  process.kill(-(pid as unknown as number), "SIGKILL"); // group kill must work
  const res = await done; // close fires; an empty run resolves (no output) rather than hanging
  expect(res.text).toBe("");
});

test("runAgent stops a run that calls AskUserQuestion and surfaces the ask (no 15-min hang)", async () => {
  process.env.CADENCE_MOCK_AGENT_ASK = "1";
  const started = Date.now();
  const res = await runAgent({ cwd: tmpdir(), role: "planner", prompt: "plan it", command: MOCK_CMD });
  // The mock hangs for 60s after asking — the runner must kill it on sight of the tool_use.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(res.asks).toHaveLength(1);
  expect(res.asks?.[0]?.tool).toBe("AskUserQuestion");
  expect(res.asks?.[0]?.toolUseId).toBe("toolu_mock_ask");
  const input = res.asks?.[0]?.input as { questions: Array<{ question: string }> };
  expect(input.questions[0]?.question).toBe("Where should the button live?");
  // A run stopped for an ask is a handoff, not a mystery failure.
  expect(res.errorDetail ?? null).toBeNull();
});

test("runAgent harvests permission_denials from the result event (name-agnostic catch-all)", async () => {
  process.env.CADENCE_MOCK_AGENT_DENIALS = "1";
  const res = await runAgent({ cwd: tmpdir(), role: "discovery", prompt: "x", command: MOCK_CMD });
  expect(res.asks).toHaveLength(1);
  expect(res.asks?.[0]?.tool).toBe("SomeFutureInteractiveTool");
  expect(res.asks?.[0]?.input).toEqual({ x: 1 });
});

test("runAgent reports errorDetail for an empty/failed run instead of staying silent", async () => {
  const res = await runAgent({
    cwd: tmpdir(),
    role: "discovery",
    prompt: "x",
    command: ["bash", "-c", "echo boom >&2; exit 3"],
  });
  expect(res.text).toBe("");
  expect(res.errorDetail).toContain("boom");
});

test("defaultStageTimeoutMs: write-stages get 60m, read-stages 15m (§6.1.g)", () => {
  expect(defaultStageTimeoutMs("implementer")).toBe(60 * 60_000);
  expect(defaultStageTimeoutMs("verifier")).toBe(60 * 60_000);
  expect(defaultStageTimeoutMs("discovery")).toBe(15 * 60_000);
  expect(defaultStageTimeoutMs("triage")).toBe(15 * 60_000);
  expect(defaultStageTimeoutMs(undefined)).toBe(15 * 60_000);
});
