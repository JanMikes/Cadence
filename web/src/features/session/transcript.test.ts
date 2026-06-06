import { expect, test } from "bun:test";
import { addUserMessage, EMPTY_TRANSCRIPT, reduceEvent } from "./transcript";

function idGen() {
  let n = 0;
  return () => `id${n++}`;
}

test("folds a streamed turn into user + assistant items + cost", () => {
  const id = idGen();
  let s = addUserMessage(EMPTY_TRANSCRIPT, "remember 42", id);
  expect(s.busy).toBe(true);
  expect(s.items[0]).toMatchObject({ kind: "user", text: "remember 42" });

  s = reduceEvent(s, { type: "stream_event", event: { type: "message_start" } }, id);
  s = reduceEvent(
    s,
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Got " } } },
    id,
  );
  s = reduceEvent(
    s,
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "it." } } },
    id,
  );
  expect(s.streaming).toBe("Got it."); // live typing accumulates

  s = reduceEvent(s, { type: "assistant", message: { content: [{ type: "text", text: "Got it." }] } }, id);
  expect(s.streaming).toBe(""); // finalized -> preview cleared
  expect(s.items.at(-1)).toMatchObject({ kind: "assistant", text: "Got it." });

  s = reduceEvent(s, { type: "result", total_cost_usd: 0.0123 }, id);
  expect(s.costUsd).toBeCloseTo(0.0123, 4);
  expect(s.busy).toBe(false);
});

test("renders tool-use blocks as tool items", () => {
  const id = idGen();
  const s = reduceEvent(
    EMPTY_TRANSCRIPT,
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file: "x" } }] } },
    id,
  );
  expect(s.items[0]).toMatchObject({ kind: "tool", toolName: "Read" });
});

test("ignores unknown event types", () => {
  const id = idGen();
  const s = reduceEvent(EMPTY_TRANSCRIPT, { type: "rate_limit_event" }, id);
  expect(s).toEqual(EMPTY_TRANSCRIPT);
});
