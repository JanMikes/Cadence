import { expect, test } from "bun:test";
import { buildResumeCommand, openInTerminal, terminalLaunchArgs } from "./terminal";

test("buildResumeCommand cds to the (shell-quoted) cwd and resumes the session", () => {
  expect(buildResumeCommand("/Users/me/code/acme", "sess-1")).toBe(
    "cd '/Users/me/code/acme' && claude --resume sess-1",
  );
  // a single quote in the path is escaped safely
  expect(buildResumeCommand("/tmp/it's mine", "s2")).toBe(
    "cd '/tmp/it'\\''s mine' && claude --resume s2",
  );
});

test("terminalLaunchArgs builds osascript for Terminal and iTerm", () => {
  const term = terminalLaunchArgs("Terminal", 'cd "/x" && claude --resume s');
  expect(term[0]).toBe("osascript");
  expect(term[1]).toBe("-e");
  expect(term[2]).toContain('tell application "Terminal"');
  expect(term[2]).toContain("do script");
  expect(term[2]).toContain('cd \\"/x\\" && claude --resume s'); // quotes escaped

  const iterm = terminalLaunchArgs("iTerm", "echo hi");
  expect(iterm[2]).toContain('tell application "iTerm"');
  expect(iterm[2]).toContain("write text");
});

test("openInTerminal hands the built argv to the (injected) runner without launching", () => {
  const calls: string[][] = [];
  openInTerminal("Terminal", "echo hi", (argv) => calls.push(argv));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("osascript");
  expect(calls[0]?.[2]).toContain("echo hi");
});
