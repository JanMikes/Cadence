import type { ClaudeEvent, TranscriptEntry } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { Info, Send, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getSessionDetail, getTranscript, sendSessionMessage } from "../../lib/api";
import { useServerMessages } from "../../lib/ws";
import {
  addUserMessage,
  EMPTY_TRANSCRIPT,
  reduceEvent,
  type TranscriptItem,
  type TranscriptState,
} from "./transcript";

let counter = 0;
const nextId = () => `t${counter++}`;

/** Chat-shaped view of the stored transcript: conversation turns + tool calls
 *  (thinking/tool-output/subagent noise stays in the Session detail terminal). */
function itemsFromFile(entries: TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const e of entries) {
    if (e.isSidechain) continue;
    if (e.kind === "text" && e.text) {
      items.push({ id: nextId(), kind: e.role === "user" ? "user" : "assistant", text: e.text });
    } else if (e.kind === "tool_use") {
      items.push({ id: nextId(), kind: "tool", toolName: e.toolName ?? "tool", toolInput: e.toolInput });
    }
  }
  return items;
}

export function SessionPanel({
  sessionId,
  onClose,
  onOpenDetail,
}: {
  sessionId: string;
  onClose: () => void;
  /** Open the rich session drawer (resume/terminal handoff) — the way forward once a session has ended. */
  onOpenDetail?: (sessionId: string) => void;
}) {
  const [state, setState] = useState<TranscriptState>(EMPTY_TRANSCRIPT);
  const [msg, setMsg] = useState("");

  // Status awareness (shares SessionDetail's cache key): the chat panel must know
  // whether anyone is still listening on the other end.
  const detail = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => getSessionDetail(sessionId),
    refetchInterval: 5000,
  });
  const s = detail.data;
  const ended = s ? !(s.isLive && (s.status === "running" || s.status === "spawning")) : false;

  // Hydrate history from the stored transcript — reopening a session (or continuing
  // an existing chat) must show the conversation so far, not a blank "started" lie.
  const file = useQuery({
    queryKey: ["transcript", sessionId],
    queryFn: () => getTranscript(sessionId),
  });
  const hydrated = useRef(false);
  const fileStamp = file.dataUpdatedAt;
  useEffect(() => {
    if (hydrated.current || !file.data?.length) return;
    hydrated.current = true;
    // Only fill in when nothing was painted yet (live WS events take precedence).
    setState((prev) =>
      prev.items.length === 0 && !prev.streaming
        ? { ...prev, items: itemsFromFile(file.data ?? []) }
        : prev,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- file.data captured via fileStamp
  }, [fileStamp]);

  useServerMessages((m) => {
    if (m.type !== "event") return;
    const p = m.payload as { sessionId?: string; event?: ClaudeEvent } | undefined;
    if (m.name === "session:event" && p?.sessionId === sessionId && p.event) {
      setState((st) => reduceEvent(st, p.event as ClaudeEvent, nextId));
    } else if (
      (m.name === "session:closed" || m.name === "session:error") &&
      p?.sessionId === sessionId
    ) {
      setState((st) => ({ ...st, busy: false }));
      void detail.refetch(); // flip the footer to "ended" right away
    }
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = msg.trim();
    if (!t) return;
    setState((st) => addUserMessage(st, t, nextId));
    setMsg("");
    void sendSessionMessage(sessionId, t).catch(() => {});
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div className="fixed inset-0 z-[60] flex justify-end bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-[680px] max-w-full flex-col border-l border-border bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="text-sm font-semibold">Claude session</div>
            <div className="text-xs text-muted-foreground">
              {sessionId.slice(0, 8)} · ${state.costUsd.toFixed(4)}
              {state.busy ? " · working…" : ended ? ` · ended (${s?.status})` : ""}
            </div>
          </div>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-auto p-5">
          {state.items.length === 0 && !state.streaming ? (
            <p className="text-sm text-muted-foreground">
              {ended
                ? "This session has ended — no output was recorded."
                : "Session started — send a message below."}
            </p>
          ) : null}
          {state.items.map((item) => (
            <TranscriptRow key={item.id} item={item} />
          ))}
          {state.streaming ? (
            <div className="whitespace-pre-wrap rounded-md bg-card px-3 py-2 text-sm">
              {state.streaming}
              <span className="animate-pulse">▌</span>
            </div>
          ) : null}
        </div>

        {ended ? (
          <div className="flex items-center justify-between gap-3 border-t border-border p-4">
            <p className="text-sm text-muted-foreground">
              This session has ended — messages can’t be sent anymore.
            </p>
            {onOpenDetail ? (
              <LabeledIconButton
                icon={<Info />}
                label="Session details"
                size="sm"
                variant="secondary"
                onClick={() => onOpenDetail(sessionId)}
              />
            ) : null}
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex gap-2 border-t border-border p-4">
            {/* biome-ignore lint/a11y/noAutofocus: chat input should be ready to type */}
            <input
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="Send a follow-up…"
              aria-label="Send a follow-up"
              autoFocus
              className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <LabeledIconButton icon={<Send />} label="Send" type="submit" disabled={!msg.trim()} />
          </form>
        )}
      </aside>
    </div>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  if (item.kind === "user") {
    return (
      <div className="max-w-[85%] self-end whitespace-pre-wrap rounded-md bg-primary/15 px-3 py-2 text-sm">
        {item.text}
      </div>
    );
  }
  if (item.kind === "tool") {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
        🔧 {item.toolName}({summarize(item.toolInput)})
      </div>
    );
  }
  return (
    <div className="whitespace-pre-wrap rounded-md bg-card px-3 py-2 text-sm">{item.text}</div>
  );
}

function summarize(input: unknown): string {
  try {
    const s = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return "";
  }
}
