import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelForRole, parseAgentJson, runAgent } from "./runner";

const MOCK_CMD = [process.execPath, join(import.meta.dir, "..", "testing", "mock-agent.ts")];

afterEach(() => {
  delete process.env.CADENCE_MOCK_AGENT_RESULT;
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
