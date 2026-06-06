/**
 * Mock one-shot `claude -p --output-format json` for agent-runner tests. Emits a
 * single JSON result object (no real model). The `result` text is taken from
 * CADENCE_MOCK_AGENT_RESULT if set (e.g. a JSON string a triage agent would
 * return), else it echoes the -p prompt. Run via `bun mock-agent.ts`.
 */
const argv = process.argv;
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? (argv[pIdx + 1] ?? "") : "";
const result = process.env.CADENCE_MOCK_AGENT_RESULT ?? `echo: ${prompt}`;

process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "success",
    result,
    total_cost_usd: 0.002,
    session_id: "mock-agent-session",
    is_error: false,
    num_turns: 1,
  })}\n`,
);

export {};
