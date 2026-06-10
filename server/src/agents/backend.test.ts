import type { AgentResult } from "@cadence/shared";
import { afterEach, expect, test } from "bun:test";
import { makeBackendRunner } from "./backend";
import type { AgentRunOptions } from "./runner";
import { SdkUnavailableError } from "./sdk-runner";

afterEach(() => {
  delete process.env.CADENCE_RUNNER_BACKEND;
});

function result(text: string): AgentResult {
  return { text, json: null, costUsd: 0, sessionId: null, isError: false, raw: {} };
}

const OPTS: AgentRunOptions = { cwd: "/tmp", role: "triage", prompt: "p" };

test("SDK is primary; a healthy run never touches the CLI", async () => {
  let cliCalls = 0;
  const run = makeBackendRunner({
    sdkRunner: async () => result("sdk"),
    cliRunner: async () => {
      cliCalls++;
      return result("cli");
    },
  });
  expect((await run(OPTS)).text).toBe("sdk");
  expect(cliCalls).toBe(0);
});

test("SDK startup failure → transparent CLI retry + cool-down breaker (no per-run double spawns)", async () => {
  let sdkCalls = 0;
  let cliCalls = 0;
  const run = makeBackendRunner({
    sdkRunner: async () => {
      sdkCalls++;
      throw new SdkUnavailableError("spawn ENOENT");
    },
    cliRunner: async () => {
      cliCalls++;
      return result("cli");
    },
  });
  // First run: SDK attempted, fails to start, CLI delivers.
  expect((await run(OPTS)).text).toBe("cli");
  expect(sdkCalls).toBe(1);
  expect(cliCalls).toBe(1);
  // Next runs inside the cool-down go straight to the CLI — the SDK isn't re-poked.
  expect((await run(OPTS)).text).toBe("cli");
  expect(sdkCalls).toBe(1);
  expect(cliCalls).toBe(2);
});

test("other SDK errors propagate — they are run outcomes, not engine failures", async () => {
  const run = makeBackendRunner({
    sdkRunner: async () => {
      throw new Error("agent timed out");
    },
    cliRunner: async () => result("cli"),
  });
  await expect(run(OPTS)).rejects.toThrow("agent timed out");
});

test("CADENCE_RUNNER_BACKEND is a debug lever: cli forces the CLI engine", async () => {
  process.env.CADENCE_RUNNER_BACKEND = "cli";
  let sdkCalls = 0;
  const run = makeBackendRunner({
    sdkRunner: async () => {
      sdkCalls++;
      return result("sdk");
    },
    cliRunner: async () => result("cli"),
  });
  expect((await run(OPTS)).text).toBe("cli");
  expect(sdkCalls).toBe(0);
});

test("injected mock commands (tests) always take the CLI spawn path", async () => {
  let cliOpts: AgentRunOptions | null = null;
  const run = makeBackendRunner({
    sdkRunner: async () => result("sdk"),
    cliRunner: async (o) => {
      cliOpts = o;
      return result("cli");
    },
  });
  await run({ ...OPTS, command: ["bun", "mock.ts"] });
  expect(cliOpts).not.toBeNull();
});
