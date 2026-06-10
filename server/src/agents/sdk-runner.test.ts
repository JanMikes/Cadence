import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { AskGate } from "./ask-gate";
import { makeSdkRunner, SdkUnavailableError } from "./sdk-runner";

/**
 * Fake SDK query: a generator the runner iterates, with access to the options it
 * was called with (so tests can exercise the canUseTool wiring exactly the way
 * the real SDK does).
 */
type FakeQuery = (params: {
  prompt: string;
  options: Record<string, unknown> & {
    canUseTool: (
      toolName: string,
      input: Record<string, unknown>,
      o: { toolUseID: string },
    ) => Promise<{ behavior: string; updatedInput?: unknown; message?: string }>;
  };
}) => AsyncGenerator<Record<string, unknown>, void>;

function runnerWith(fake: FakeQuery, askGate?: AskGate) {
  return makeSdkRunner({ queryFn: fake as never, askGate });
}

function resultEvent(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    result: text,
    total_cost_usd: 0.01,
    session_id: "sdk-session",
    is_error: false,
    ...extra,
  };
}

const ASK_INPUT = {
  questions: [{ question: "Where?", header: "Placement", options: [{ label: "A" }, { label: "B" }] }],
};

function gateAnswering(answers: Record<string, string | string[]> | null): AskGate {
  return {
    askQuestions: async () => answers,
    approveTool: async () => false,
    pendingCount: () => 0,
  };
}

test("maps the SDK stream to an AgentResult and forwards events live", async () => {
  const fake: FakeQuery = async function* () {
    yield { type: "system", subtype: "init", session_id: "sdk-session" };
    yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    yield resultEvent('```json\n{"ok":true}\n```');
  };
  const types: string[] = [];
  const res = await runnerWith(fake)({
    cwd: tmpdir(),
    role: "discovery",
    prompt: "p",
    onEvent: (e) => types.push(e.type),
  });
  expect(types).toEqual(["system", "assistant", "result"]);
  expect(res.json).toEqual({ ok: true });
  expect(res.costUsd).toBeCloseTo(0.01, 5);
  expect(res.sessionId).toBe("sdk-session");
  expect(res.isError).toBe(false);
  expect(res.asks ?? []).toHaveLength(0);
});

test("AskUserQuestion answered live: the run continues with the user's answers", async () => {
  let captured: unknown = null;
  const fake: FakeQuery = async function* (params) {
    yield { type: "system", subtype: "init" };
    const decision = await params.options.canUseTool("AskUserQuestion", ASK_INPUT, { toolUseID: "t1" });
    captured = decision;
    yield resultEvent('{"plan":"made with the answer"}');
  };
  const res = await runnerWith(fake, gateAnswering({ "Where?": "B" }))({
    cwd: tmpdir(),
    role: "planner",
    prompt: "p",
  });
  // The answer was fed back INTO the run (verified updatedInput contract)…
  expect(captured).toEqual({
    behavior: "allow",
    updatedInput: { questions: ASK_INPUT.questions, answers: { "Where?": "B" } },
  });
  // …and the run finished normally with no recorded asks.
  expect(res.json).toEqual({ plan: "made with the answer" });
  expect(res.asks ?? []).toHaveLength(0);
});

test("AskUserQuestion unanswered: denied with guidance and recorded as an ask", async () => {
  let message = "";
  const fake: FakeQuery = async function* (params) {
    yield { type: "system", subtype: "init" };
    const d = await params.options.canUseTool("AskUserQuestion", ASK_INPUT, { toolUseID: "t1" });
    message = String(d.message ?? "");
    yield resultEvent(""); // the model floundered — no usable output
  };
  const res = await runnerWith(fake, gateAnswering(null))({ cwd: tmpdir(), role: "planner", prompt: "p" });
  expect(message).toContain("assumption");
  expect(res.asks).toHaveLength(1);
  expect(res.asks?.[0]).toMatchObject({ tool: "AskUserQuestion", toolUseId: "t1" });
});

test("ExitPlanMode is denied with a corrective message — the run stays alive", async () => {
  let behavior = "";
  const fake: FakeQuery = async function* (params) {
    yield { type: "system", subtype: "init" };
    const d = await params.options.canUseTool("ExitPlanMode", { plan: "..." }, { toolUseID: "t2" });
    behavior = d.behavior;
    // the corrective deny let the model recover and print its real output
    yield resultEvent('{"recovered":true}');
  };
  const res = await runnerWith(fake)({ cwd: tmpdir(), role: "discovery", prompt: "p" });
  expect(behavior).toBe("deny");
  expect(res.json).toEqual({ recovered: true });
  // recorded for the run report, but present alongside a usable result
  expect(res.asks?.[0]?.tool).toBe("ExitPlanMode");
});

test("permission_denials from the result event are harvested without duplicating live asks", async () => {
  const fake: FakeQuery = async function* (params) {
    yield { type: "system", subtype: "init" };
    await params.options.canUseTool("AskUserQuestion", ASK_INPUT, { toolUseID: "t1" });
    yield resultEvent("", {
      permission_denials: [
        { tool_name: "AskUserQuestion", tool_use_id: "t1", tool_input: ASK_INPUT }, // dup of the live ask
        { tool_name: "SomeFutureTool", tool_use_id: "t9", tool_input: { x: 1 } }, // unknown tool — still caught
      ],
    });
  };
  const res = await runnerWith(fake, gateAnswering(null))({ cwd: tmpdir(), role: "triage", prompt: "p" });
  expect(res.asks).toHaveLength(2);
  expect(res.asks?.map((a) => a.tool).sort()).toEqual(["AskUserQuestion", "SomeFutureTool"]);
});

test("nothing ever arrived → SdkUnavailableError (the dispatcher falls back to the CLI)", async () => {
  // biome-ignore lint/correctness/useYield: simulates an SDK that dies before emitting anything
  const fake: FakeQuery = async function* () {
    throw new Error("spawn ENOENT");
  };
  await expect(runnerWith(fake)({ cwd: tmpdir(), role: "triage", prompt: "p" })).rejects.toBeInstanceOf(
    SdkUnavailableError,
  );
});

test("Manual mode (default): other tools route to the approval gate", async () => {
  const decisions: string[] = [];
  const gate: AskGate = {
    askQuestions: async () => null,
    approveTool: async (toolName) => toolName === "Bash",
    pendingCount: () => 0,
  };
  const fake: FakeQuery = async function* (params) {
    yield { type: "system", subtype: "init" };
    decisions.push((await params.options.canUseTool("Bash", { command: "ls" }, { toolUseID: "a" })).behavior);
    decisions.push((await params.options.canUseTool("WebFetch", { url: "x" }, { toolUseID: "b" })).behavior);
    yield resultEvent("done");
  };
  await runnerWith(fake, gate)({
    cwd: tmpdir(),
    role: "implementer",
    prompt: "p",
    permissionMode: "default",
  });
  expect(decisions).toEqual(["allow", "deny"]);
});
