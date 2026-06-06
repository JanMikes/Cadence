import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeDir,
  readLiveSessions,
  readTranscript,
  transcriptPathFor,
} from "./transcripts";

let claude: string;

beforeEach(() => {
  claude = mkdtempSync(join(tmpdir(), "cadence-claude-"));
  process.env.CADENCE_CLAUDE_DIR = claude;
});

afterEach(() => {
  delete process.env.CADENCE_CLAUDE_DIR;
  rmSync(claude, { recursive: true, force: true });
});

test("transcriptPathFor encodes the (real) cwd under the claude projects dir", () => {
  const p = transcriptPathFor("/Users/me/code/acme", "sess-1");
  expect(p).toBe(join(claudeDir(), "projects", "-Users-me-code-acme", "sess-1.jsonl"));
});

test("readLiveSessions flags a live pid alive and a bogus pid dead", () => {
  const dir = join(claude, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "live", cwd: "/x", status: "busy", kind: "interactive", updatedAt: 2 }),
  );
  writeFileSync(
    join(dir, "999999.json"),
    JSON.stringify({ pid: 999999, sessionId: "dead", cwd: "/y", status: "idle", kind: "cli", updatedAt: 1 }),
  );

  const live = readLiveSessions();
  expect(live).toHaveLength(2);
  const byId = Object.fromEntries(live.map((s) => [s.sessionId, s]));
  expect(byId.live?.alive).toBe(true);
  expect(byId.live?.status).toBe("busy");
  expect(byId.dead?.alive).toBe(false);
  expect(live[0]?.sessionId).toBe("live"); // sorted by updatedAt desc
});

test("readTranscript parses user/assistant lines + flags sidechain subagent activity", () => {
  const file = join(claude, "t.jsonl");
  const lines = [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "do the thing" } },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "On it." },
          { type: "tool_use", name: "Task", input: {} },
        ],
      },
    },
    {
      type: "assistant",
      uuid: "s1",
      parentUuid: "a1",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "subagent reading files" }] },
    },
    { type: "ai-title", title: "ignored metadata line" },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

  const entries = readTranscript(file);
  expect(entries.map((e) => e.kind)).toEqual(["text", "text", "tool_use", "text"]);
  expect(entries[0]).toMatchObject({ role: "user", text: "do the thing", isSidechain: false });
  expect(entries[2]).toMatchObject({ kind: "tool_use", toolName: "Task" });
  // the subagent line is flagged for nesting
  const sidechain = entries.find((e) => e.isSidechain);
  expect(sidechain?.text).toBe("subagent reading files");
});
