import type { LiveSession } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getLiveSessions, getSessions } from "../../lib/api";
import { roleLabel } from "../../lib/status";
import { cn } from "../../lib/utils";

function statusDot(status: string, alive = true): string {
  if (!alive) return "bg-muted";
  if (status === "busy") return "bg-green-500 animate-pulse";
  if (status === "idle") return "bg-muted-foreground";
  if (status === "shell") return "bg-blue-400";
  if (status === "running" || status === "spawning") return "bg-green-500";
  if (status === "done") return "bg-muted-foreground";
  if (status === "failed" || status === "killed") return "bg-red-500";
  return "bg-yellow-500";
}

export function SessionsView({ onOpenSessionDetail }: { onOpenSessionDetail: (id: string) => void }) {
  const live = useQuery({ queryKey: ["live-sessions"], queryFn: getLiveSessions, refetchInterval: 3000 });
  const tracked = useQuery({ queryKey: ["sessions", "all"], queryFn: getSessions });
  const trackedIds = new Set(tracked.data?.map((s) => s.id));
  const [filter, setFilter] = useState<"all" | "chat" | "agent">("all");
  const shown = (tracked.data ?? []).filter((s) =>
    filter === "all" ? true : filter === "agent" ? s.kind === "oneshot" : s.kind !== "oneshot",
  );

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Live Claude Code processes (from the liveness oracle) and Cadence-tracked sessions. Click a session
        to see details, history, controls, and organization.
      </p>

      <section className="mt-6">
        <h2 className="text-sm font-medium">Live processes</h2>
        <ul className="mt-2 flex flex-col gap-1.5">
          {live.data?.length === 0 ? (
            <li className="text-xs text-muted-foreground">No live processes.</li>
          ) : null}
          {live.data?.map((s) => (
            <LiveTile
              key={s.pid}
              session={s}
              onOpen={trackedIds.has(s.sessionId) ? () => onOpenSessionDetail(s.sessionId) : undefined}
            />
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Cadence sessions</h2>
          <div className="flex gap-1">
            {(
              [
                ["all", "All"],
                ["chat", "Chats"],
                ["agent", "Agent stages"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs transition-colors",
                  filter === id
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:border-primary/40",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ul className="mt-2 flex flex-col gap-1.5">
          {shown.length === 0 ? <li className="text-xs text-muted-foreground">No sessions yet.</li> : null}
          {shown.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onOpenSessionDetail(s.id)}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary/50"
              >
                <span className={cn("size-2 shrink-0 rounded-full", statusDot(s.status))} />
                <span className="font-medium">{roleLabel(s.role)}</span>
                {s.kind === "oneshot" ? (
                  <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    stage
                  </span>
                ) : null}
                <span className="truncate text-muted-foreground">{s.cwd}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">${s.costUsd.toFixed(4)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function LiveTile({ session, onOpen }: { session: LiveSession; onOpen?: () => void }) {
  const body = (
    <>
      <span className={cn("size-2 shrink-0 rounded-full", statusDot(session.status, session.alive))} />
      <span className="font-medium">{session.status}</span>
      {!session.alive ? <span className="text-red-400">(stale)</span> : null}
      <span className="font-mono text-muted-foreground">pid {session.pid}</span>
      <span className="truncate text-muted-foreground">{session.cwd}</span>
      {onOpen ? <span className="ml-auto shrink-0 text-primary">tracked →</span> : null}
    </>
  );
  if (onOpen) {
    return (
      <li>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary/50"
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs">
      {body}
    </li>
  );
}
