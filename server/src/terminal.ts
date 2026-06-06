import { spawn } from "node:child_process";

/** Single-quote a string for safe use in a POSIX shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The copy-paste / handoff command that resumes a session in the terminal (§5). */
export function buildResumeCommand(cwd: string, sessionId: string): string {
  return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the `osascript` argv that opens the given terminal app and runs `command`
 * in a new window/tab. Supports Terminal.app and iTerm. Pure (no side effects) so
 * it's unit-testable; openInTerminal() actually spawns it.
 */
export function terminalLaunchArgs(app: string, command: string): string[] {
  const cmd = appleScriptString(command);
  if (app === "iTerm" || app === "iTerm2") {
    const script = [
      'tell application "iTerm"',
      "  activate",
      "  set w to (create window with default profile)",
      `  tell current session of w to write text "${cmd}"`,
      "end tell",
    ].join("\n");
    return ["osascript", "-e", script];
  }
  // Default: Terminal.app
  const script = [
    'tell application "Terminal"',
    "  activate",
    `  do script "${cmd}"`,
    "end tell",
  ].join("\n");
  return ["osascript", "-e", script];
}

export type TerminalRunner = (argv: string[]) => void;

const defaultRunner: TerminalRunner = ([cmd, ...args]) => {
  spawn(cmd as string, args, { stdio: "ignore", detached: true }).unref();
};

/** Open `command` in the given terminal app. The runner is injectable for tests. */
export function openInTerminal(app: string, command: string, run: TerminalRunner = defaultRunner): void {
  run(terminalLaunchArgs(app, command));
}
