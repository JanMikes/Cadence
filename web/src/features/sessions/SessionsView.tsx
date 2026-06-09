import type { LiveSession, Session } from "@cadence/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  clearFinishedSessions,
  getLiveSessions,
  getSessions,
  getTasks,
  killSession,
  refineTask,
  stopSession,
} from "../../lib/api";
import { roleLabel } from "../../lib/status";
import { cn } from "../../lib/utils";

function statusDot(status: string, alive = true): string {
  if (!alive) return "bg-muted";
  if (status === "busy") return "bg-green-500 animate-pulse";
  if (status === "idle") return "bg-muted-foreground";
  if (status === "shell") return "bg-blue-400";
  if (status === "running" || status === "spawning") return "bg-green-500 animate-pulse";
  if (status === "done") return "bg-muted-foreground";
  if (status === "failed" || status === "killed") return "bg-red-500";
  return "bg-yellow-500";
}

function elapsed(startedAt: number | null): string {
  if (!startedAt) return "";
  const m = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function SessionsView({ onOpenSessionDetail }: { onOpenSessionDetail: (id: string) => void }) {
  const live = useQuery({ queryKey: ["live-sessions"], queryFn: getLiveSessions, refetchInterval: 3000 });
  // Refresh the tracked list while open so running ↔ done transitions show up promptly.
  const tracked = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => getSessions(),
    refetchInterval: 5000,
  });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => getTasks() });
  const taskTitles = new Map((tasks.data ?? []).map((t) => [t.id, t.title]));
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
        to watch its output live, see history, controls, and organization.
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
          <div className="flex items-center gap-1">
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
            <ClearFinishedButton />
          </div>
        </div>
        <ul className="mt-2 flex flex-col gap-1.5">
          {shown.length === 0 ? <li className="text-xs text-muted-foreground">No sessions yet.</li> : null}
          {shown.map((s) => (
            <li key={s.id}>
              <SessionRow
                session={s}
                taskTitle={s.taskId ? taskTitles.get(s.taskId) : undefined}
                onOpen={() => onOpenSessionDetail(s.id)}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Two-step "Clear finished" (no native confirm): first click arms, second executes. */
function ClearFinishedButton() {
  const qc = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!armed) {
          setArmed(true);
          window.setTimeout(() => setArmed(false), 4000); // disarm if not confirmed
          return;
        }
        setBusy(true);
        try {
          await clearFinishedSessions();
          void qc.invalidateQueries({ queryKey: ["sessions", "all"] });
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
      className={cn(
        "ml-2 rounded-md border px-2 py-0.5 text-xs transition-colors",
        armed
          ? "border-red-500/60 bg-red-500/10 text-red-400"
          : "border-border text-muted-foreground hover:border-primary/40",
      )}
      title="Remove finished agent-stage rows from this list. Transcripts stay on disk."
    >
      {busy ? "Clearing…" : armed ? "✓ Confirm clear" : "🧹 Clear finished"}
    </button>
  );
}

function SessionRow({
  session: s,
  taskTitle,
  onOpen,
}: {
  session: Session;
  taskTitle?: string;
  onOpen: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const running = s.status === "running" || s.status === "spawning";
  const longRunning = running && s.startedAt != null && Date.now() - s.startedAt > 10 * 60_000;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ["sessions", "all"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    } finally {
      setBusy(null);
    }
  };

  return (
    // A div, not a <button>: the row hosts real action buttons (nested buttons are invalid HTML).
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary/50"
    >
      <span className={cn("size-2 shrink-0 rounded-full", statusDot(s.status))} />
      <span className="shrink-0 font-medium">{roleLabel(s.role)}</span>
      {s.kind === "oneshot" ? (
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          stage
        </span>
      ) : null}
      {longRunning ? (
        <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-400">
          ⚠ long run
        </span>
      ) : null}
      {taskTitle ? <span className="truncate text-foreground/80">{taskTitle}</span> : null}
      <span className={cn("truncate text-muted-foreground", taskTitle && "hidden sm:inline")}>{s.cwd}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {running ? (
          <>
            <span className="flex items-center gap-1 text-emerald-400">
              running · {elapsed(s.startedAt)}
            </span>
            <RowAction
              label={busy === "stop" ? "Stopping…" : "■ Stop"}
              title="Ask the run to finish gracefully (SIGINT)"
              disabled={busy != null}
              onClick={(e) => {
                e.stopPropagation();
                void act("stop", () => stopSession(s.id));
              }}
            />
            <RowAction
              label={busy === "kill" ? "Killing…" : "✕ Kill"}
              title="Force-stop the run and its child processes (SIGKILL)"
              danger
              disabled={busy != null}
              onClick={(e) => {
                e.stopPropagation();
                void act("kill", () => killSession(s.id));
              }}
            />
            {s.kind === "oneshot" && s.role === "discovery" && s.taskId ? (
              <RowAction
                label={busy === "retry" ? "Retrying…" : "↻ Kill & retry"}
                title="Kill this run and start a fresh refinement (budgeted)"
                disabled={busy != null}
                onClick={(e) => {
                  e.stopPropagation();
                  void act("retry", async () => {
                    await killSession(s.id);
                    await refineTask(s.taskId as string).catch(() => {
                      /* 409 = something else is already refining — that's fine */
                    });
                  });
                }}
              />
            ) : null}
          </>
        ) : (
          `$${s.costUsd.toFixed(4)}`
        )}
      </span>
    </div>
  );
}

function RowAction({
  label,
  title,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50",
        danger
          ? "border-red-500/40 text-red-400 hover:border-red-500/70 hover:bg-red-500/10"
          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
      )}
    >
      {label}
    </button>
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
