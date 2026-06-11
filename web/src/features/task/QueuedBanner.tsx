import type { LockBlocker } from "@cadence/shared";
import { ArrowUpRight, Bot, Hourglass, MessageSquare, ScrollText, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { useActivityInfo } from "../../lib/activity";

/**
 * Why a task sits in line instead of running (§10: never lie about state, no
 * silent dead ends). Shown while the activity tracker reports the "queued"
 * pseudo-stage — the project folder is occupied and the run starts by itself
 * when it frees up. Each blocker says WHO occupies the folder (a Cadence task,
 * a Cadence chat session, or the user's own claude terminal) and deep-links to
 * it: tasks open the task detail, sessions open the session-detail drawer
 * (external claude processes included — the server resolves them read-only
 * from the liveness oracle).
 */

const KIND_INFO: Record<
  LockBlocker["kind"],
  { icon: typeof Bot; tag: string; tagClass: string }
> = {
  execution: { icon: Bot, tag: "Cadence task", tagClass: "bg-sky-500/15 text-sky-300" },
  session: { icon: MessageSquare, tag: "Cadence session", tagClass: "bg-sky-500/15 text-sky-300" },
  external: {
    icon: TerminalSquare,
    tag: "Your Claude session",
    tagClass: "bg-violet-500/15 text-violet-300",
  },
};

/** "waiting 4m" — re-rendered every 30s so it never freezes at "waiting <1m". */
function waitingFor(startedAt: number, now: number): string {
  const m = Math.max(0, Math.round((now - startedAt) / 60_000));
  if (m < 1) return "waiting <1 min";
  if (m < 60) return `waiting ${m} min`;
  return `waiting ${Math.floor(m / 60)}h ${m % 60}m`;
}

export function QueuedBanner({
  taskId,
  onOpenTask,
  onOpenSessionDetail,
}: {
  taskId: string;
  /** Open the blocking task's detail (replaces this one). */
  onOpenTask?: (taskId: string) => void;
  /** Open the session-detail drawer — works for external claude sessions too. */
  onOpenSessionDetail?: (sessionId: string) => void;
}) {
  const activity = useActivityInfo(taskId);
  const [now, setNow] = useState(() => Date.now());
  const queued = activity?.stage === "queued";
  useEffect(() => {
    if (!queued) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [queued]);

  if (!queued || !activity) return null;
  const blockers = activity.blockers ?? [];
  const hasExternal = blockers.some((b) => b.kind === "external");

  return (
    <div className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
          <Hourglass className="size-4 shrink-0" aria-hidden />
          <span>Queued — the project folder is busy</span>
        </div>
        <span className="text-xs text-amber-300/70">{waitingFor(activity.startedAt, now)}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Only one thing can change this project’s files at a time. The run starts automatically the
        moment the folder frees up — nothing for you to do, unless you want it sooner.
      </p>

      {blockers.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {blockers.map((b, i) => {
            const info = KIND_INFO[b.kind];
            const Icon = info.icon;
            return (
              <li
                key={`${b.kind}-${b.sessionId ?? b.taskId ?? b.pid ?? i}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2 text-xs"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${info.tagClass}`}>
                  {info.tag}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/90" title={b.label}>
                  {b.label}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {b.taskId && onOpenTask ? (
                    <LabeledIconButton
                      icon={<ArrowUpRight />}
                      label="Open task"
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenTask(b.taskId as string)}
                    />
                  ) : null}
                  {b.sessionId && onOpenSessionDetail ? (
                    <LabeledIconButton
                      icon={<ScrollText />}
                      label="View session"
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenSessionDetail(b.sessionId as string)}
                    />
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : activity.detail ? (
        // Older payloads carry only the joined label string — still better than silence.
        <p className="mt-3 text-xs text-foreground/90">Waiting for {activity.detail}.</p>
      ) : null}

      {hasExternal ? (
        <p className="mt-3 text-xs text-muted-foreground">
          <span className="font-medium text-violet-300">Waiting on your own session?</span> Finish or
          exit that terminal and this run starts immediately — or enable{" "}
          <span className="font-medium">worktrees</span> for this project in Settings so runs work in
          an isolated copy and never wait.
        </p>
      ) : null}
    </div>
  );
}
