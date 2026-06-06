import type { ClaudeEvent } from "@cadence/shared";

export interface TranscriptItem {
  id: string;
  kind: "user" | "assistant" | "tool";
  text?: string; // user / assistant
  toolName?: string; // tool
  toolInput?: unknown; // tool
}

export interface TranscriptState {
  items: TranscriptItem[];
  /** In-progress assistant text being typed live (from text_delta events). */
  streaming: string;
  costUsd: number;
  /** A turn is in flight (waiting on the model). */
  busy: boolean;
}

export const EMPTY_TRANSCRIPT: TranscriptState = {
  items: [],
  streaming: "",
  costUsd: 0,
  busy: false,
};

/** Optimistically record a user message we just sent (the session won't echo it). */
export function addUserMessage(
  state: TranscriptState,
  text: string,
  nextId: () => string,
): TranscriptState {
  return {
    ...state,
    items: [...state.items, { id: nextId(), kind: "user", text }],
    streaming: "",
    busy: true,
  };
}

/**
 * Fold one `claude` stream-json event into the transcript (control surfaces §3.2):
 * - stream_event → live token typing (content_block_delta/text_delta) + busy on message_start
 * - assistant    → finalized text / tool-use blocks (clears the streaming preview)
 * - result       → accumulate cost, end the turn
 * Unknown event types pass through unchanged (the schema is unversioned).
 */
export function reduceEvent(
  state: TranscriptState,
  ev: ClaudeEvent,
  nextId: () => string,
): TranscriptState {
  switch (ev.type) {
    case "stream_event": {
      const raw = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (raw?.type === "message_start") return { ...state, busy: true };
      if (raw?.type === "content_block_delta" && raw.delta?.type === "text_delta") {
        return { ...state, streaming: state.streaming + (raw.delta.text ?? "") };
      }
      return state;
    }
    case "assistant": {
      const content = (ev.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return state;
      const add: TranscriptItem[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          add.push({ id: nextId(), kind: "assistant", text: block.text });
        } else if (block.type === "tool_use") {
          add.push({
            id: nextId(),
            kind: "tool",
            toolName: typeof block.name === "string" ? block.name : "tool",
            toolInput: block.input,
          });
        }
      }
      if (!add.length) return state;
      return { ...state, items: [...state.items, ...add], streaming: "" };
    }
    case "result": {
      const c = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0;
      return { ...state, costUsd: state.costUsd + c, streaming: "", busy: false };
    }
    default:
      return state;
  }
}
