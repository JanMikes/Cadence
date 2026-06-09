import type { AgentResult, ClaudeEvent } from "@cadence/shared";
import { spawn } from "node:child_process";

/** Default model per agent role (spec §7; overridable per project/task). */
export function modelForRole(role?: string): string | undefined {
  switch (role) {
    case "triage":
    case "delivery":
    case "reflector":
      return "claude-haiku-4-5";
    case "discovery":
    case "questioner":
    case "verifier":
      return "claude-sonnet-4-6";
    case "planner":
    case "implementer":
      return "claude-opus-4-8";
    default:
      return undefined; // let claude pick its default
  }
}

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  role?: string;
  model?: string;
  appendSystemPrompt?: string;
  /** Resume a prior session (one-shot --resume: cheap cache-read, §3.4). */
  resumeSessionId?: string;
  /** JSON for `--agents` (subagent library, 2.2). */
  agentsJson?: string;
  /** A real claude --permission-mode. Defaults to "plan" (read-only) for safety. */
  permissionMode?: string;
  /** Override the base command (tests pass ["bun", mockPath]). */
  command?: string[];
  timeoutMs?: number;
  /**
   * Assign the claude session id up front (`--session-id`) so the transcript lands at a
   * deterministic path (transcriptPathFor). Set by the recording runner; ignored when resuming.
   */
  sessionId?: string;
  /** The task this run belongs to — recording metadata for the session row (not a claude arg). */
  taskId?: string;
  /** Called once with the child pid right after spawn — lets callers track/stop the process. */
  onSpawn?: (pid: number | null) => void;
  /** Called for every stream-json event as it arrives — powers live output in the UI. */
  onEvent?: (event: ClaudeEvent) => void;
}

/** Try to parse the agent's result text as JSON (tolerates ```json fences). */
export function parseAgentJson(text: string): unknown | null {
  const t = text.trim();
  if (!t) return null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : t)?.trim() ?? "";
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Build the final AgentResult from the run's `result` event (or last JSON object seen). */
function toAgentResult(raw: Record<string, unknown> | null): AgentResult {
  const obj = raw ?? {};
  const text = typeof obj.result === "string" ? obj.result : "";
  return {
    text,
    json: parseAgentJson(text),
    costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    sessionId: typeof obj.session_id === "string" ? obj.session_id : null,
    isError: obj.is_error === true || obj.subtype === "error",
    raw,
  };
}

/**
 * Run a one-shot agent: `claude -p <prompt> --output-format stream-json [...]` in cwd.
 * Stateless + crash-proof (vs. the warm session in 1.4); resume is cache-read.
 * Defaults to the read-only "plan" permission mode unless overridden.
 *
 * stream-json (vs. plain json) costs nothing and buys live output: every event is
 * parsed as it arrives and forwarded to `onEvent`, so the UI can stream a run in
 * real time. The final `result` event carries the same fields the old json blob did.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentResult> {
  const base = opts.command ?? [process.env.CADENCE_CLAUDE_BIN ?? "claude"];
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose", // REQUIRED with stream-json in print mode
    "--include-partial-messages", // live token deltas for the streaming UI
    "--permission-mode",
    opts.permissionMode ?? "plan",
  ];
  const model = opts.model ?? modelForRole(opts.role);
  if (model) args.push("--model", model);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // --session-id and --resume are mutually exclusive; resume already owns its session id.
  else if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.agentsJson) args.push("--agents", opts.agentsJson);

  return await new Promise<AgentResult>((resolve, reject) => {
    // Capture stderr too (don't discard it) so a failing agent run is diagnosable instead of silent.
    const child = spawn(base[0] as string, [...base.slice(1), ...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    opts.onSpawn?.(child.pid ?? null);

    // Parse stdout incrementally (don't buffer a long run's full delta stream in memory):
    // keep only the most recent JSON object — the `result` event is always last.
    let last: Record<string, unknown> | null = null;
    let sawAny = false;
    let buf = "";
    let err = "";
    const handleLine = (line: string): void => {
      if (!line) return;
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        sawAny = true;
        if (ev && typeof ev === "object") {
          if (typeof ev.type === "string") opts.onEvent?.(ev as ClaudeEvent);
          // Remember the result event (or the last object, for mocks emitting one blob).
          if (ev.type === "result" || last == null || last.type !== "result") last = ev;
        }
      } catch {
        // Tolerate non-JSON noise (the schema is unversioned — §7).
      }
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("agent timed out"));
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (c: Buffer) => {
      buf += c.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        handleLine(line);
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      handleLine(buf.trim()); // a final line without a trailing newline
      // Surface a failed/empty run instead of swallowing it (the caller turns this into a visible note).
      if ((code && code !== 0) || !sawAny) {
        const detail = err.trim() || `exit ${code ?? "?"}`;
        console.warn(`[cadence] agent (${opts.role ?? "?"}) produced no output: ${detail.slice(0, 500)}`);
      }
      resolve(toAgentResult(last));
    });
  });
}
