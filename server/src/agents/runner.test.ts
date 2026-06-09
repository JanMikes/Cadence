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
