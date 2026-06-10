import type { Task } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ActivityInfo, stageNoun, useActivityMap } from "../../lib/activity";
import { getTasks } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useConnectionStatus } from "../../lib/ws";

/**
 * The top-bar live status: what Cadence is doing right now, as per-stage pills
 * ("3× Triaging · 1× Implementing", spinner per pill), with a click-to-open panel
 * listing every active run (task title + live elapsed). On connection trouble the
 * whole thing is replaced by the amber/red connectivity state — healthy needs no
 * green badge, and activity is never rendered over a socket we can't verify.
 * Below `md` the pills collapse to one "N working" summary so an ~800px window fits.
 */
export function HeaderStatus({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const conn = useConnectionStatus();
  const activity = useActivityMap();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the runs panel on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (conn.state !== "connected") {
    const red = conn.state === "disconnected";
    return (
      <span
        className={cn(
          "inline-flex items-center gap-2 text-xs font-medium",
          red ? "text-red-400" : "text-amber-300",
        )}
        title={
          red
            ? "The Cadence gateway isn't reachable. Retrying every few seconds — agent activity is hidden until the connection is verified."
            : "The connection blipped — verifying. Most blips heal within a second or two."
        }
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            red ? "bg-red-500" : "animate-pulse bg-amber-400",
          )}
        />
        {red
          ? "Disconnected — retrying every 5 s"
          : conn.state === "connecting"
            ? "Connecting to Cadence…"
            : "Connection lost — reconnecting…"}
      </span>
    );
  }

  const runs = Object.entries(activity); // [taskId, info]
  if (runs.length === 0) {
    return (
      <span
        className="inline-flex items-center gap-2 text-xs text-muted-foreground"
        title="No agents are running. Press PLAY on a task (or capture one) to put Cadence to work."
      >
        <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
        Idle — all caught up
      </span>
    );
  }

  // Group by stage, biggest first, stable order within a count via stage name.
  const groups = new Map<string, Array<{ taskId: string } & ActivityInfo>>();
  for (const [taskId, info] of runs) {
    const list = groups.get(info.stage) ?? [];
    list.push({ taskId, ...info });
    groups.set(info.stage, list);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const MAX_PILLS = 3;
  const shown = sorted.slice(0, MAX_PILLS);
  const extra = sorted.length - shown.length;

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-2">
      {/* Narrow screens: one summary pill. */}
      <StagePill
        className="md:hidden"
        spinner
        label={`${runs.length} working`}
        onClick={() => setOpen((o) => !o)}
        open={open}
      />
      {/* md and up: a pill per stage + overflow. */}
      {shown.map(([stage, list]) => (
        <StagePill
          key={stage}
          className="hidden md:inline-flex"
          spinner={stage !== "queued"}
          label={`${list.length}× ${stageNoun(stage)}`}
          onClick={() => setOpen((o) => !o)}
          open={open}
        />
      ))}
      {extra > 0 ? (
        <StagePill
          className="hidden md:inline-flex"
          label={`+${extra} more`}
          onClick={() => setOpen((o) => !o)}
          open={open}
        />
      ) : null}
      {open ? (
        <RunsPanel
          groups={sorted}
          onOpenTask={(id) => {
            setOpen(false);
            onOpenTask(id);
          }}
        />
      ) : null}
    </div>
  );
}

function StagePill({
  label,
  spinner,
  onClick,
  open,
  className,
}: {
  label: string;
  spinner?: boolean;
  onClick: () => void;
  open: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      title="Show the running agents"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20",
        className,
      )}
    >
      {spinner ? (
        <span
          aria-hidden
          className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
        />
      ) : (
        <Clock className="size-3 shrink-0" />
      )}
      {label}
    </button>
  );
}

/** Dropdown listing every active run, grouped by stage, with live elapsed times. */
function RunsPanel({
  groups,
  onOpenTask,
}: {
  groups: Array<[string, Array<{ taskId: string } & ActivityInfo>]>;
  onOpenTask: (taskId: string) => void;
}) {
  // Shares the board's task cache so titles are usually already loaded.
  const tasks = useQuery({
    queryKey: ["tasks", "all", "urgency"],
    queryFn: () => getTasks({ sort: "urgency" }),
  });
  const titles = new Map<string, string>((tasks.data ?? []).map((t: Task) => [t.id, t.title]));

  // Tick once a second while the panel is open so elapsed times run live.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="absolute left-0 top-full z-50 mt-2 max-h-96 w-80 overflow-auto rounded-lg border border-border bg-card p-2 shadow-xl">
      {groups.map(([stage, list]) => (
        <div key={stage} className="mb-1 last:mb-0">
          <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {stageNoun(stage)} · {list.length}
          </div>
          {list.map((run) => (
            <button
              key={`${run.taskId}:${stage}`}
              type="button"
              onClick={() => onOpenTask(run.taskId)}
              title={stage === "queued" && run.detail ? `Waiting for ${run.detail}` : undefined}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              {stage === "queued" ? (
                // Queued = in line, not running — a clock, not a spinner (never lie about state).
                <Clock className="size-2.5 shrink-0 text-muted-foreground" />
              ) : (
                <span
                  aria-hidden
                  className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground">
                {titles.get(run.taskId) ?? "(task)"}
                {stage === "queued" && run.detail ? (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    waiting for {run.detail}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {fmtElapsed(Date.now() - run.startedAt)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
