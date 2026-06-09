import type { ClaudeEvent, TranscriptEntry } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getTranscript } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useServerMessages } from "../../lib/ws";
import { EMPTY_LIVE, type LiveState, prunePending, reduceLive } from "./live-transcript";

/**
 * The session's output as a live terminal: canonical history from the on-disk
 * transcript (polled while running), with token-level typing + just-finished
 * blocks layered on top from the live event stream. Fixed dark, monospaced
 * styling on purpose — it reads like the terminal the session would run in.
 */
export function LiveTranscript({ sessionId, running }: { sessionId: string; running: boolean }) {
  const t = useQuery({
    queryKey: ["transcript", sessionId],
    queryFn: () => getTranscript(sessionId),
    refetchInterval: running ? 1000 : false,
  });
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE);

  useServerMessages((m) => {
    if (m.type !== "event" || m.name !== "session:event") return;
    const p = m.payload as { sessionId?: string; event?: ClaudeEvent } | undefined;
    if (p?.sessionId !== sessionId || !p.event) return;
    const event = p.event;
    setLive((s) => reduceLive(s, event));
  });

  const file = t.data ?? [];
  // GC pending blocks once the polled file contains them (render-time prune below
  // keeps the view duplicate-free even before this state update lands).
  const dataStamp = t.dataUpdatedAt;
  useEffect(() => {
    setLive((s) => (s.pending.length ? { ...s, pending: prunePending(t.data ?? [], s.pending) } : s));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t.data is captured via dataStamp
  }, [dataStamp]);

  // When the run ends, fetch the file once more so the tail is complete after polling stops.
  const refetch = t.refetch;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void refetch();
    wasRunning.current = running;
  }, [running, refetch]);

  const entries = [...file, ...prunePending(file, live.pending)];
  const typing = running ? live.typing : "";

  // Stick to the bottom like a real terminal — unless the user scrolled up to read.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [entries.length, typing, follow]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#0b0d11]">
      {/* Window chrome — makes the surface read as "the terminal", not a list */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-3 py-1.5">
        <span aria-hidden className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-red-500/70" />
          <span className="size-2.5 rounded-full bg-yellow-500/70" />
          <span className="size-2.5 rounded-full bg-green-500/70" />
        </span>
        <span className="font-mono text-[11px] text-zinc-400">
          claude · {sessionId.slice(0, 8)}
        </span>
        <span className="ml-auto">
          {running ? (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
              streaming live
            </span>
          ) : (
            <span className="font-mono text-[11px] text-zinc-500">ended</span>
          )}
        </span>
      </div>

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
          }}
          className="max-h-[60vh] min-h-[10rem] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
        >
          {t.isLoading ? <p className="text-zinc-500">Loading transcript…</p> : null}
          {!t.isLoading && entries.length === 0 && !typing ? (
            running ? (
              <p className="text-zinc-400">
                <span className="text-emerald-400">⏺</span> Claude is starting up — output will
                stream here in a moment.
              </p>
            ) : (
              <p className="text-zinc-500">No output was recorded for this session.</p>
            )
          ) : null}

          {entries.map((e, i) => (
            <Line key={`${e.uuid ?? "live"}-${i}`} entry={e} />
          ))}

          {typing ? (
            <div className="whitespace-pre-wrap py-0.5 text-zinc-200">
              {typing}
              <Cursor />
            </div>
          ) : running && entries.length > 0 ? (
            <div className="py-0.5">
              <Cursor />
            </div>
          ) : null}
        </div>

        {!follow ? (
          <div className="absolute bottom-3 right-3">
            <LabeledIconButton
              icon={<ArrowDown />}
              label="Jump to latest"
              size="sm"
              variant="secondary"
              className="shadow-lg"
              onClick={() => {
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setFollow(true);
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Cursor() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse rounded-[1px] bg-emerald-400/80 align-text-bottom"
    />
  );
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One terminal line/block, colored by kind like the real CLI. */
function Line({ entry }: { entry: TranscriptEntry }) {
  let body: ReactNode = null;

  if (entry.kind === "tool_use") {
    body = (
      <div className="text-emerald-300">
        <span aria-hidden className="select-none">
          ⏺{" "}
        </span>
        <span className="font-semibold">{entry.toolName}</span>
        {entry.toolInput ? <span className="text-zinc-500">({clip(entry.toolInput, 160)})</span> : null}
      </div>
    );
  } else if (entry.kind === "tool_result") {
    body = <ToolResult text={entry.text ?? ""} />;
  } else if (entry.kind === "thinking") {
    body = (
      <details className="text-zinc-500">
        <summary className="cursor-pointer select-none italic marker:text-zinc-600">
          ✻ thinking…
        </summary>
        <div className="mt-0.5 whitespace-pre-wrap border-l border-zinc-800 pl-3 italic">
          {entry.text}
        </div>
      </details>
    );
  } else if (entry.kind === "text") {
    body = entry.role === "user" ? <UserText text={entry.text ?? ""} /> : (
      <div className="whitespace-pre-wrap text-zinc-200">{entry.text}</div>
    );
  } else {
    return null;
  }

  return (
    <div
      className={cn(
        "py-0.5",
        entry.isSidechain && "ml-3 border-l border-violet-500/40 pl-3", // subagent activity, nested
      )}
    >
      {body}
    </div>
  );
}

/** User/prompt lines: `❯` prefix; long composed prompts collapse to one line. */
function UserText({ text }: { text: string }) {
  const lines = text.split("\n");
  const long = lines.length > 8 || text.length > 800;
  if (!long) {
    return (
      <div className="text-zinc-100">
        <span aria-hidden className="select-none font-semibold text-cyan-400">
          ❯{" "}
        </span>
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    );
  }
  return (
    <details className="text-zinc-100">
      <summary className="cursor-pointer select-none marker:text-zinc-600">
        <span aria-hidden className="font-semibold text-cyan-400">
          ❯{" "}
        </span>
        {clip(lines[0] ?? "", 120)}{" "}
        <span className="text-zinc-500">(prompt · {lines.length} lines)</span>
      </summary>
      <div className="mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap border-l border-zinc-800 pl-3 text-zinc-300">
        {text}
      </div>
    </details>
  );
}

/** Tool output: short results inline, long ones collapsed to their first line. */
function ToolResult({ text }: { text: string }) {
  const lines = text.split("\n");
  const long = lines.length > 4 || text.length > 600;
  if (!long) {
    return (
      <div className="whitespace-pre-wrap text-zinc-500">
        <span aria-hidden className="select-none">
          {"  "}⎿{" "}
        </span>
        {text}
      </div>
    );
  }
  return (
    <details className="text-zinc-500">
      <summary className="cursor-pointer select-none marker:text-zinc-600">
        <span aria-hidden>
          {"  "}⎿{" "}
        </span>
        {clip(lines[0] ?? "", 120)} <span className="text-zinc-600">(+{lines.length - 1} lines)</span>
      </summary>
      <pre className="mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap border-l border-zinc-800 pl-3">
        {clip(text, 20_000)}
      </pre>
    </details>
  );
}
