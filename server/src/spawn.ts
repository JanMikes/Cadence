import type { ClaudeEvent } from "@cadence/shared";
import { type ChildProcess, spawn } from "node:child_process";

export interface SpawnOptions {
  sessionId: string;
  cwd: string;
  model?: string;
  /** A real claude permission mode: default | acceptEdits | plan | bypassPermissions. */
  permissionMode?: string;
  appendSystemPrompt?: string;
  /** Override the base command (tests use ["bun", mockPath]); default ["claude"]. */
  command?: string[];
  extraArgs?: string[];
  onEvent: (event: ClaudeEvent) => void;
  onClose?: (code: number | null) => void;
  onError?: (err: Error) => void;
}

export interface SessionHandle {
  pid: number | undefined;
  send: (text: string) => void;
  close: () => void;
  kill: () => void;
}

/**
 * Open a warm, long-lived Claude Code session in stream-json mode (control
 * surfaces §3.3). Parses newline-delimited JSON stdout into typed events. Keep
 * the stdin pipe open to keep the session warm; close() sends EOF to end it.
 */
export function openSession(opts: SpawnOptions): SessionHandle {
  const base = opts.command ?? [process.env.CADENCE_CLAUDE_BIN ?? "claude"];
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose", // REQUIRED with stream-json in print mode
    "--include-partial-messages", // live token deltas
    "--session-id",
    opts.sessionId,
    "--permission-mode",
    opts.permissionMode ?? "default",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.extraArgs) args.push(...opts.extraArgs);

  const child: ChildProcess = spawn(base[0] as string, [...base.slice(1), ...args], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        opts.onEvent(JSON.parse(line) as ClaudeEvent);
      } catch {
        // Tolerate non-JSON noise (the schema is unversioned — §7).
      }
    }
  });
  if (opts.onError) child.on("error", opts.onError);
  if (opts.onClose) child.on("close", opts.onClose);

  return {
    pid: child.pid,
    send: (text: string) =>
      child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`),
    close: () => child.stdin?.end(),
    kill: () => child.kill("SIGINT"),
  };
}
