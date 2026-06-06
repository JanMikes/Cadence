import type { ClaudeEvent } from "@cadence/shared";
import { Send, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { sendSessionMessage } from "../../lib/api";
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

export function SessionPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [state, setState] = useState<TranscriptState>(EMPTY_TRANSCRIPT);
  const [msg, setMsg] = useState("");

  useServerMessages((m) => {
    if (m.type !== "event") return;
    const p = m.payload as { sessionId?: string; event?: ClaudeEvent } | undefined;
    if (m.name === "session:event" && p?.sessionId === sessionId && p.event) {
      setState((s) => reduceEvent(s, p.event as ClaudeEvent, nextId));
    } else if (
      (m.name === "session:closed" || m.name === "session:error") &&
      p?.sessionId === sessionId
    ) {
      setState((s) => ({ ...s, busy: false }));
    }
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = msg.trim();
    if (!t) return;
    setState((s) => addUserMessage(s, t, nextId));
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
              {state.busy ? " · working…" : ""}
            </div>
          </div>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-auto p-5">
          {state.items.length === 0 && !state.streaming ? (
            <p className="text-sm text-muted-foreground">Session started — send a message below.</p>
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
    const s = JSON.stringify(input) ?? "";
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return "";
  }
}
