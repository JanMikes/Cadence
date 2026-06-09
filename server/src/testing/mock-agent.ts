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

const resultEvent = {
  type: "result",
  subtype: "success",
  result,
  total_cost_usd: 0.002,
  session_id: "mock-agent-session",
  is_error: false,
  num_turns: 1,
};

const emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

if (process.env.CADENCE_MOCK_AGENT_STREAM === "1") {
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
