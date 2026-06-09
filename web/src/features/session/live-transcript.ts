import type { ClaudeEvent, TranscriptEntry } from "@cadence/shared";

/**
 * Live-streaming transcript logic (pure — the LiveTranscript component renders it).
 *
 * Two sources feed one view:
 *   1. the polled on-disk transcript (canonical, complete messages), and
 *   2. live `session:event` stream-json events (token deltas + just-finished blocks).
 * Completed blocks from events are held in `pending` only until the next poll
 * delivers them from the file — `prunePending` dedupes by content so nothing
 * ever shows twice and nothing flickers away.
 */

export interface LiveState {
  /** Blocks completed live that the polled file hasn't delivered yet. */
  pending: TranscriptEntry[];
  /** The assistant text currently being typed (token deltas since the last block). */
  typing: string;
}

export const EMPTY_LIVE: LiveState = { pending: [], typing: "" };

/** One-line JSON of a tool input, clipped — mirrors the server's compactJson. */
function compactJson(value: unknown, max = 200): string | null {
  if (value == null) return null;
  try {
    const s = JSON.stringify(value) ?? "";
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return null;
  }
}

/** Build pending entries from a live assistant/user stream-json event. */
export function entriesFromEvent(ev: ClaudeEvent): TranscriptEntry[] {
  if (ev.type !== "assistant" && ev.type !== "user") return [];
  const message = ev.message as { role?: string; content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const base = {
    uuid: null,
    parentUuid: null,
    role: message?.role ?? ev.type,
    isSidechain: false,
    timestamp: null,
  };
  const out: TranscriptEntry[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type === "text" && typeof b.text === "string" && b.text) {
      out.push({ ...base, kind: "text", text: b.text, toolName: null, toolInput: null });
    } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
      out.push({ ...base, kind: "thinking", text: b.thinking, toolName: null, toolInput: null });
    } else if (b.type === "tool_use") {
      out.push({
        ...base,
        kind: "tool_use",
        text: null,
        toolName: String(b.name ?? "tool"),
        toolInput: compactJson(b.input),
      });
    } else if (b.type === "tool_result") {
      const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      out.push({ ...base, kind: "tool_result", text: t ?? null, toolName: null, toolInput: null });
    }
  }
  return out;
}

/** Content identity for file↔live dedupe. */
export function entryKey(e: TranscriptEntry): string {
  return `${e.kind}|${e.toolName ?? ""}|${(e.text ?? e.toolInput ?? "").slice(0, 400)}`;
}

/** Drop pending entries the polled file now contains (checked against its tail). */
export function prunePending(file: TranscriptEntry[], pending: TranscriptEntry[]): TranscriptEntry[] {
  if (pending.length === 0) return pending;
  const tail = new Set(file.slice(-60).map(entryKey));
  const next = pending.filter((p) => !tail.has(entryKey(p)));
  return next.length === pending.length ? pending : next;
}

/** Fold one live stream-json event into the live state. */
export function reduceLive(state: LiveState, ev: ClaudeEvent): LiveState {
  if (ev.type === "stream_event") {
    const raw = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (raw?.type === "content_block_delta" && raw.delta?.type === "text_delta") {
      return { ...state, typing: state.typing + (raw.delta.text ?? "") };
    }
    return state;
  }
  if (ev.type === "assistant" || ev.type === "user") {
    const add = entriesFromEvent(ev);
    if (add.length === 0) return ev.type === "assistant" ? { ...state, typing: "" } : state;
    return { pending: [...state.pending, ...add], typing: "" };
  }
  if (ev.type === "result") return { ...state, typing: "" };
  return state;
}
