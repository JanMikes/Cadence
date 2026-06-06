/**
 * Mock `claude` for tests — emulates the stream-json protocol (control surfaces
 * §3.2) deterministically, with NO real model call. Run as `bun mock-claude.ts`
 * via openSession's `command` override. Ignores the claude flags (except
 * --session-id), emits system/init on start, then per stdin user line emits an
 * assistant block + a result with a fixed cost, and exits on stdin EOF.
 */
const argv = process.argv;
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const sessionId = flag("--session-id") ?? "mock-session";
const appendSystemPrompt = flag("--append-system-prompt"); // echoed for context-composition tests
const permissionMode = flag("--permission-mode") ?? "default"; // echoed for permission-mode tests

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  cwd: process.cwd(),
  model: "mock-model",
  permissionMode,
  tools: [],
  appendSystemPrompt,
});

const decoder = new TextDecoder();
let buf = "";

process.stdin.on("data", (chunk: Buffer) => {
  buf += decoder.decode(chunk);
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let text = "ok";
    try {
      const msg = JSON.parse(line) as { message?: { content?: unknown } };
      if (typeof msg.message?.content === "string") text = msg.message.content;
    } catch {
      // ignore malformed input
    }
    emit({
      type: "assistant",
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: `echo: ${text}`,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 5 },
      num_turns: 1,
      is_error: false,
      duration_ms: 5,
    });
  }
});

process.stdin.on("end", () => process.exit(0));

export {};
