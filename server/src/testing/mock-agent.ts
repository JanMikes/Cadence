/**
 * Mock one-shot `claude -p --output-format stream-json` for agent-runner tests.
 * Emits a single JSON result object by default (regression: the parser must
 * tolerate a plain blob); with CADENCE_MOCK_AGENT_STREAM=1 it emits a realistic
 * stream-json sequence (init → deltas → assistant → result) to exercise live
 * event forwarding. The `result` text is taken from CADENCE_MOCK_AGENT_RESULT
 * if set (e.g. a JSON string a triage agent would return), else it echoes the
 * -p prompt. Run via `bun mock-agent.ts`.
 */
const argv = process.argv;
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? (argv[pIdx + 1] ?? "") : "";
const result = process.env.CADENCE_MOCK_AGENT_RESULT ?? `echo: ${prompt}`;

const resultEvent: Record<string, unknown> = {
  type: "result",
  subtype: "success",
  result,
  total_cost_usd: 0.002,
  session_id: "mock-agent-session",
  is_error: false,
  num_turns: 1,
};
// Name-agnostic denial channel: ANY denied tool (incl. ones we don't know yet)
// lands in the result event's permission_denials — exercised by runner tests.
if (process.env.CADENCE_MOCK_AGENT_DENIALS === "1") {
  resultEvent.permission_denials = [
    { tool_name: "SomeFutureInteractiveTool", tool_use_id: "toolu_denied", tool_input: { x: 1 } },
  ];
}

const emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

if (process.env.CADENCE_MOCK_AGENT_ASK === "1") {
  // Simulate the live-incident shape (2026-06-10): the agent calls AskUserQuestion,
  // headless claude auto-denies it, and the run flounders/hangs — the runner must
  // stop it on sight of the tool_use and surface the ask.
  emit({ type: "system", subtype: "init", session_id: "mock-agent-session", model: "mock-model" });
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_mock_ask",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Where should the button live?",
                header: "Placement",
                multiSelect: false,
                options: [{ label: "Task detail" }, { label: "Board card" }],
              },
            ],
          },
        },
      ],
    },
  });
  await Bun.sleep(60_000); // hang — the runner's kill is what ends this run
} else if (process.env.CADENCE_MOCK_AGENT_STREAM === "1") {
  emit({ type: "system", subtype: "init", session_id: "mock-agent-session", model: "mock-model" });
  await Bun.sleep(10);
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "wor" } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "king" } } });
  await Bun.sleep(10);
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: result }] } });
  emit(resultEvent);
} else {
  emit(resultEvent);
}

export {};
