import type { AgentResult } from "@cadence/shared";
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

function parseOutput(stdout: string): AgentResult {
  let raw: Record<string, unknown> | string | null = null;
  const trimmed = stdout.trim();
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // tolerate extra lines — take the last valid JSON line
    for (const line of trimmed.split("\n").reverse()) {
      try {
        raw = JSON.parse(line.trim()) as Record<string, unknown>;
        break;
      } catch {
        // keep looking
      }
    }
  }

  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text =
    typeof obj.result === "string" ? obj.result : typeof raw === "string" ? raw : "";
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
 * Run a one-shot agent: `claude -p <prompt> --output-format json [...]` in cwd.
 * Stateless + crash-proof (vs. the warm session in 1.4); resume is cache-read.
 * Defaults to the read-only "plan" permission mode unless overridden.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentResult> {
  const base = opts.command ?? [process.env.CADENCE_CLAUDE_BIN ?? "claude"];
  const args = ["-p", opts.prompt, "--output-format", "json", "--permission-mode", opts.permissionMode ?? "plan"];
  const model = opts.model ?? modelForRole(opts.role);
  if (model) args.push("--model", model);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // --session-id and --resume are mutually exclusive; resume already owns its session id.
  else if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.agentsJson) args.push("--agents", opts.agentsJson);

  const stdout = await new Promise<string>((resolve, reject) => {
    // Capture stderr too (don't discard it) so a failing agent run is diagnosable instead of silent.
    const child = spawn(base[0] as string, [...base.slice(1), ...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("agent timed out"));
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
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
      // Surface a failed/empty run instead of swallowing it (the caller turns this into a visible note).
      if ((code && code !== 0) || out.trim() === "") {
        const detail = err.trim() || `exit ${code ?? "?"}`;
        console.warn(`[cadence] agent (${opts.role ?? "?"}) produced no output: ${detail.slice(0, 500)}`);
      }
      resolve(out);
    });
  });

  return parseOutput(stdout);
}
