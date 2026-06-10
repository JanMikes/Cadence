import type { AgentResult, ClaudeEvent, InteractiveAsk } from "@cadence/shared";
import { spawn } from "node:child_process";
import { claudeSubprocessEnv } from "../claude-env";
import { killGroup } from "../liveness";
import { opsSettings } from "../ops";
import { getAgentModel } from "./prompts";

// modelForRole moved to prompts.ts (§6.3.b — it's a registry concern now); re-exported
// so existing importers keep working.
export { modelForRole } from "./prompts";

/**
 * Hard per-run ceiling (§6.1.g) so no one-shot can burn tokens forever: read stages
 * 15 min; implementer/verifier (real builds + tests) 60 min — both live Settings
 * knobs (§6.3.e). Callers may override via opts.timeoutMs; an explicit 0 disables it.
 */
export function defaultStageTimeoutMs(role?: string): number {
  const ops = opsSettings();
  switch (role) {
    case "implementer":
    case "verifier":
      return ops.implementStageTimeoutMinutes * 60_000;
    default:
      return ops.readStageTimeoutMinutes * 60_000;
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

/**
 * Tools that exist to talk to a human RIGHT NOW. In a headless `claude -p` run the CLI
 * auto-denies them (tool_result `is_error` + "Answer questions?" / "Exit plan mode?"),
 * the model flounders, and the run burns time producing nothing usable — verified
 * against binary v2.1.x and live incidents (2026-06-10). The moment one appears in the
 * stream we already hold its full input (the questions / the plan), so the right move
 * is: stop the run and hand the ask to the user. Unknown future interactive tools are
 * still caught generically via the result event's `permission_denials` (see below).
 */
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Standing contract appended to every one-shot system prompt: nobody is watching the
 * run, so interactive tools can only dead-end (prevention layer; detection above is
 * the safety net for when the model ignores it — plan mode actively nudges it to).
 */
export const NON_INTERACTIVE_CONTRACT =
  "NON-INTERACTIVE RUN: this is an unattended one-shot — no human can see or answer anything " +
  "until it ends. Never use interactive tools (AskUserQuestion, ExitPlanMode, or anything that " +
  "waits for a person); they fail here. If you are missing information or need a decision, state " +
  "the open questions in your final output using the response format your instructions define, " +
  "then stop.";

/** Interactive tool_use blocks in an `assistant` stream event (incl. subagent events). */
function interactiveAsksIn(ev: Record<string, unknown>): InteractiveAsk[] {
  if (ev.type !== "assistant") return [];
  const message = ev.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const asks: InteractiveAsk[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === "tool_use" && INTERACTIVE_TOOLS.has(String(block.name))) {
      asks.push({
        tool: String(block.name),
        toolUseId: typeof block.id === "string" ? block.id : null,
        input: block.input ?? null,
      });
    }
  }
  return asks;
}

/**
 * Name-agnostic catch-all: the final `result` event lists EVERY tool call the CLI
 * denied (`permission_denials: [{tool_name, tool_use_id, tool_input}]`) — including
 * interactive tools we don't know about yet. Forward-compatible by construction.
 */
function denialAsks(ev: Record<string, unknown>): InteractiveAsk[] {
  const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
  return (denials as Array<Record<string, unknown>>).map((d) => ({
    tool: String(d?.tool_name ?? "unknown"),
    toolUseId: typeof d?.tool_use_id === "string" ? d.tool_use_id : null,
    input: d?.tool_input ?? null,
  }));
}

/**
 * Try to parse the agent's result text as JSON. Tolerant by design — agents wrap
 * their JSON in ```json fences, lead with prose, and (the 2026-06-11 incident)
 * embed markdown code fences INSIDE JSON string values, so a lazy fence regex
 * truncates a perfectly valid payload. Ladder: whole text → outer fence (greedy
 * to the LAST ```) → first "{" to last "}".
 */
export function parseAgentJson(text: string): unknown | null {
  const t = text.trim();
  if (!t) return null;
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return null;
    }
  };
  // 1. The whole text is the JSON.
  const whole = tryParse(t);
  if (whole !== null) return whole;
  // 2. Fenced: strip the OUTER fence — close at the LAST ``` so fences embedded
  //    inside JSON strings (spec/code snippets) can't truncate the payload.
  const open = t.match(/```(?:json)?\s*\n?/);
  if (open?.index != null) {
    const start = open.index + open[0].length;
    const end = t.lastIndexOf("```");
    if (end > start) {
      const fenced = tryParse(t.slice(start, end).trim());
      if (fenced !== null) return fenced;
    }
  }
  // 3. Last resort: the outermost object braces (prose-wrapped JSON).
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) return tryParse(t.slice(first, last + 1));
  return null;
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
  // Per-call > per-agent override (Settings, §6.3.b) > role default.
  const model = opts.model ?? getAgentModel(opts.role);
  if (model) args.push("--model", model);
  // Every one-shot carries the non-interactive contract — composed after any
  // caller-provided layer so it always lands (prevention; detection backs it up).
  const appendSystemPrompt = opts.appendSystemPrompt
    ? `${opts.appendSystemPrompt}\n\n${NON_INTERACTIVE_CONTRACT}`
    : NON_INTERACTIVE_CONTRACT;
  args.push("--append-system-prompt", appendSystemPrompt);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // --session-id and --resume are mutually exclusive; resume already owns its session id.
  else if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.agentsJson) args.push("--agents", opts.agentsJson);

  return await new Promise<AgentResult>((resolve, reject) => {
    // Capture stderr too (don't discard it) so a failing agent run is diagnosable instead of silent.
    // detached: the child leads its own process GROUP (§6.1.e), so stopping a run can kill
    // claude *and its children* via kill(-pid) instead of leaving grandchildren behind.
    const child = spawn(base[0] as string, [...base.slice(1), ...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: claudeSubprocessEnv(), // subscription guard — never silently bill the API
    });
    opts.onSpawn?.(child.pid ?? null);

    // Parse stdout incrementally (don't buffer a long run's full delta stream in memory):
    // keep only the most recent JSON object — the `result` event is always last.
    let last: Record<string, unknown> | null = null;
    let sawAny = false;
    let buf = "";
    let err = "";
    const asks: InteractiveAsk[] = [];
    let stoppedForAsk = false;
    const handleLine = (line: string): void => {
      if (!line) return;
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        sawAny = true;
        if (ev && typeof ev === "object") {
          if (typeof ev.type === "string") opts.onEvent?.(ev as ClaudeEvent);
          // Remember the result event (or the last object, for mocks emitting one blob).
          if (ev.type === "result" || last == null || last.type !== "result") last = ev;
          // Interactive ask in flight → we already hold the full question/plan payload,
          // and headless claude can only dead-end on it (auto-deny, then flounder or
          // hang). Stop the run NOW and hand the ask to the caller — don't burn the
          // stage timeout on a conversation nobody can have.
          const live = interactiveAsksIn(ev);
          if (live.length) {
            asks.push(...live);
            if (!stoppedForAsk) {
              stoppedForAsk = true;
              if (child.pid != null) killGroup(child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            }
          }
          // Catch-all for tools we don't know: every denied call is listed here.
          if (ev.type === "result") {
            const seen = new Set(asks.map((a) => a.toolUseId).filter(Boolean));
            asks.push(...denialAsks(ev).filter((a) => !a.toolUseId || !seen.has(a.toolUseId)));
          }
        }
      } catch {
        // Tolerate non-JSON noise (the schema is unversioned — §7).
      }
    };

    const timeoutMs = opts.timeoutMs ?? defaultStageTimeoutMs(opts.role);
    const timer = timeoutMs
      ? setTimeout(() => {
          if (child.pid != null) killGroup(child.pid, "SIGKILL");
          else child.kill("SIGKILL");
          reject(new Error("agent timed out"));
        }, timeoutMs)
      : null;
    if (timer && typeof timer.unref === "function") timer.unref();
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
      const result = toAgentResult(last);
      if (asks.length) result.asks = asks;
      // Surface a failed/empty run instead of swallowing it — on the result itself
      // (callers turn it into a visible note), not just the server log. A run we
      // stopped for an interactive ask is not a failure; the ask explains it.
      if (!stoppedForAsk && ((code && code !== 0) || !sawAny)) {
        const detail = err.trim() || `claude exited with code ${code ?? "?"} and no output`;
        result.errorDetail = detail.slice(0, 1000);
        console.warn(`[cadence] agent (${opts.role ?? "?"}) produced no output: ${detail.slice(0, 500)}`);
      }
      resolve(result);
    });
  });
}
