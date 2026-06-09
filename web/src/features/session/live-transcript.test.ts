import type { TranscriptEntry } from "@cadence/shared";
import { expect, test } from "bun:test";
import { EMPTY_LIVE, entriesFromEvent, prunePending, reduceLive } from "./live-transcript";

const fileEntry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
  uuid: "u1",
  parentUuid: null,
  role: "assistant",
  kind: "text",
  text: null,
  toolName: null,
  toolInput: null,
  isSidechain: false,
  timestamp: null,
  ...over,
});

test("reduceLive accumulates token deltas into typing, clears on the finished block", () => {
  let s = EMPTY_LIVE;
  s = reduceLive(s, {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
  });
  s = reduceLive(s, {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
  });
  expect(s.typing).toBe("Hello");

  s = reduceLive(s, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
  });
  expect(s.typing).toBe(""); // the block finished — typing handed over to pending
  expect(s.pending).toHaveLength(1);
  expect(s.pending[0]).toMatchObject({ kind: "text", text: "Hello" });
});

test("entriesFromEvent maps tool_use + tool_result blocks (live tool activity)", () => {
  const use = entriesFromEvent({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
    },
  });
  expect(use[0]).toMatchObject({ kind: "tool_use", toolName: "Bash", toolInput: '{"command":"bun test"}' });

  const result = entriesFromEvent({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "42 pass" }] },
  });
  expect(result[0]).toMatchObject({ kind: "tool_result", text: "42 pass" });
});

test("prunePending drops pending blocks once the polled file contains them", () => {
  const pending = entriesFromEvent({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "done!" }] },
  });
  // file hasn't caught up → kept
  expect(prunePending([], pending)).toHaveLength(1);
  // file delivered the same content → deduped away, nothing renders twice
  const file = [fileEntry({ kind: "text", text: "done!" })];
  expect(prunePending(file, pending)).toHaveLength(0);
});

test("a result event only clears typing (turn boundary)", () => {
  const s = reduceLive({ pending: [], typing: "half a sent" }, { type: "result", total_cost_usd: 0.1 });
  expect(s.typing).toBe("");
  expect(s.pending).toHaveLength(0);
});
