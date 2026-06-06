import type { LiveSession, TranscriptEntry } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getLiveSessions, getSessions, getTranscript } from "../../lib/api";
import { cn } from "../../lib/utils";

function statusDot(status: string, alive = true): string {
  if (!alive) return "bg-muted";
  if (status === "busy") return "bg-green-500 animate-pulse";
  if (status === "idle") return "bg-muted-foreground";
  if (status === "shell") return "bg-blue-400";
  if (status === "running") return "bg-green-500";
  if (status === "done") return "bg-muted-foreground";
  if (status === "failed") return "bg-red-500";
  return "bg-yellow-500";
}

export function SessionsView() {
  const live = useQuery({ queryKey: ["live-sessions"], queryFn: getLiveSessions, refetchInterval: 3000 });
  const tracked = useQuery({ queryKey: ["sessions", "all"], queryFn: getSessions });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Live Claude Code processes (from the liveness oracle) and Cadence-tracked sessions.
      </p>

      <section className="mt-6">
        <h2 className="text-sm font-medium">Live processes</h2>
        <ul className="mt-2 flex flex-col gap-1.5">
          {live.data?.length === 0 ? (
            <li className="text-xs text-muted-foreground">No live processes.</li>
          ) : null}
          {live.data?.map((s) => (
            <LiveTile key={s.pid} session={s} />
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium">Cadence sessions</h2>
        <ul className="mt-2 flex flex-col gap-1.5">
          {tracked.data?.length === 0 ? (
            <li className="text-xs text-muted-foreground">No sessions yet.</li>
          ) : null}
          {tracked.data?.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setOpenId(s.id)}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary/50"
              >
                <span className={cn("size-2 shrink-0 rounded-full", statusDot(s.status))} />
                <span className="font-mono">{s.id.slice(0, 8)}</span>
                <span className="truncate text-muted-foreground">{s.role} · {s.cwd}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">${s.costUsd.toFixed(4)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {openId ? <TranscriptReader sessionId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function LiveTile({ session }: { session: LiveSession }) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs">
      <span className={cn("size-2 shrink-0 rounded-full", statusDot(session.status, session.alive))} />
      <span className="font-medium">{session.status}</span>
      {!session.alive ? <span className="text-red-400">(stale)</span> : null}
      <span className="font-mono text-muted-foreground">pid {session.pid}</span>
      <span className="truncate text-muted-foreground">{session.cwd}</span>
    </li>
  );
}

function TranscriptReader({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const t = useQuery({ queryKey: ["transcript", sessionId], queryFn: () => getTranscript(sessionId) });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div className="fixed inset-0 z-[60] flex justify-end bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-[680px] max-w-full flex-col border-l border-border bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="text-sm font-semibold">Transcript · {sessionId.slice(0, 8)}</div>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </header>
        <div className="flex flex-1 flex-col gap-2 overflow-auto p-5">
          {t.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {t.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transcript on disk yet for this session.</p>
          ) : null}
          {t.data?.map((e, i) => (
            <TranscriptLine key={`${e.uuid ?? "x"}-${i}`} entry={e} />
          ))}
        </div>
      </aside>
    </div>
  );
}

function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  const sidechain = entry.isSidechain;
  return (
    <div className={cn(sidechain && "ml-5 border-l-2 border-primary/30 pl-3")}>
      <div className="mb-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium">{entry.role}</span>
        {sidechain ? <span className="rounded bg-primary/15 px-1 text-primary">subagent</span> : null}
        {entry.kind !== "text" ? <span>· {entry.kind}</span> : null}
      </div>
      {entry.kind === "tool_use" ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-1.5 font-mono text-xs">
          🔧 {entry.toolName}
        </div>
      ) : (
        <div
          className={cn(
            "whitespace-pre-wrap rounded-md px-3 py-2 text-sm",
            entry.kind === "thinking" ? "bg-muted/30 italic text-muted-foreground" : "bg-card",
          )}
        >
          {entry.text}
        </div>
      )}
    </div>
  );
}
