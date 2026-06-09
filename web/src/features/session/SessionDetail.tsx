import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Ban, MessageSquare, Square, Trash2, X } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import {
  deleteSession,
  getFleets,
  getProjects,
  getSessionDetail,
  getTasks,
  killSession,
  stopSession,
  updateSession,
} from "../../lib/api";
import { cn } from "../../lib/utils";
import { HandoffButtons } from "./HandoffButtons";
import { SessionTranscript } from "./SessionTranscript";

const PERMISSION_LABELS: Record<string, string> = {
  auto: "Auto",
  manual: "Manual",
  dangerous: "Dangerous",
  acceptEdits: "Auto",
  bypassPermissions: "Dangerous",
  default: "Manual",
  plan: "Plan",
};

function statusDot(status: string, isLive: boolean): string {
  if (status === "running" || status === "spawning") return "bg-green-500 animate-pulse";
  if (status === "awaiting_feedback") return "bg-yellow-500";
  if (status === "failed") return "bg-red-500";
  if (status === "killed") return "bg-red-400";
  if (status === "idle") return isLive ? "bg-green-500" : "bg-muted-foreground";
  return "bg-muted-foreground"; // done
}

function formatDuration(start: number | null, end: number | null): string {
  if (!start) return "—";
  const ms = (end ?? Date.now()) - start;
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function SessionDetail({
  sessionId,
  onClose,
  onContinue,
  onOpenTask,
}: {
  sessionId: string;
  onClose: () => void;
  /** Open the live chat panel to keep talking to a running session. */
  onContinue: (sessionId: string) => void;
  /** Jump to the linked task's detail. */
  onOpenTask: (taskId: string) => void;
}) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => getSessionDetail(sessionId),
    refetchInterval: 2000, // keep status / cost / liveness fresh while open
  });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => getTasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const fleets = useQuery({ queryKey: ["fleets"], queryFn: getFleets });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["session", sessionId] });
    void qc.invalidateQueries({ queryKey: ["sessions", "all"] });
    void qc.invalidateQueries({ queryKey: ["task"] }); // task session lists
  };

  const assign = useMutation({
    mutationFn: (patch: Parameters<typeof updateSession>[1]) => updateSession(sessionId, patch),
    onSuccess: invalidate,
  });
  const stop = useMutation({ mutationFn: () => stopSession(sessionId), onSuccess: invalidate });
  const kill = useMutation({ mutationFn: () => killSession(sessionId), onSuccess: invalidate });
  const del = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const s = detail.data;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div className="fixed inset-0 z-[55] flex justify-end bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-[680px] max-w-full flex-col overflow-auto border-l border-border bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {s ? <span className={cn("size-2 shrink-0 rounded-full", statusDot(s.status, s.isLive))} /> : null}
              Session · <span className="font-mono">{sessionId.slice(0, 8)}</span>
              {s ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                  {s.role}
                </span>
              ) : null}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">{s?.cwd ?? ""}</div>
          </div>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </header>

        {!s ? (
          <div className="p-5 text-sm text-muted-foreground">
            {detail.isError ? "Couldn’t load this session." : "Loading…"}
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-6 p-5">
            {/* Controls */}
            <div className="flex flex-wrap items-center gap-2">
              {s.isLive ? (
                <>
                  <LabeledIconButton
                    icon={<MessageSquare />}
                    label="Continue chat"
                    size="sm"
                    onClick={() => onContinue(sessionId)}
                  />
                  <LabeledIconButton
                    icon={<Square />}
                    label="Stop"
                    variant="secondary"
                    size="sm"
                    onClick={() => stop.mutate()}
                    disabled={stop.isPending}
                  />
                  <LabeledIconButton
                    icon={<Ban />}
                    label="Kill"
                    variant="outline"
                    size="sm"
                    onClick={() => kill.mutate()}
                    disabled={kill.isPending}
                  />
                </>
              ) : null}
              <HandoffButtons sessionId={sessionId} cwd={s.cwd} />
              <LabeledIconButton
                icon={<Trash2 />}
                label="Delete"
                variant="destructive"
                size="sm"
                onClick={() => setConfirmDelete(true)}
              />
            </div>
            {!s.isLive ? (
              <p className="-mt-3 text-xs text-muted-foreground">
                This process has ended — use <span className="font-medium">Open in terminal</span> to resume it
                with <code className="font-mono">claude --resume</code>.
              </p>
            ) : null}

            {/* Details */}
            <dl className="grid grid-cols-[7rem_1fr] items-center gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", statusDot(s.status, s.isLive))} />
                {s.status}
                {s.isLive ? <span className="text-xs text-green-500">live</span> : null}
              </dd>

              <dt className="text-muted-foreground">Kind</dt>
              <dd>{s.kind}</dd>

              <dt className="text-muted-foreground">Model</dt>
              <dd>{s.model ?? "—"}</dd>

              <dt className="text-muted-foreground">Permission</dt>
              <dd>{s.permissionMode ? (PERMISSION_LABELS[s.permissionMode] ?? s.permissionMode) : "—"}</dd>

              <dt className="text-muted-foreground">Cost</dt>
              <dd title="Accumulated session cost — an effort signal, not a budget">
                ${s.costUsd.toFixed(4)}
              </dd>

              <dt className="text-muted-foreground">PID</dt>
              <dd className="font-mono">{s.pid ?? "—"}</dd>

              <dt className="text-muted-foreground">Started</dt>
              <dd>{s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"}</dd>

              <dt className="text-muted-foreground">Duration</dt>
              <dd>
                {formatDuration(s.startedAt, s.endedAt)}
                {s.endedAt ? "" : s.isLive ? " · running" : ""}
              </dd>

              <dt className="text-muted-foreground">Branch</dt>
              <dd className="truncate font-mono text-xs">{s.branch ?? "—"}</dd>
            </dl>

            {/* Organization */}
            <section className="border-t border-border pt-5">
              <h3 className="text-sm font-medium">Organization</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Assign this session to a task, project, or fleet to keep your history organized.
              </p>
              <dl className="mt-3 grid grid-cols-[5rem_1fr] items-center gap-y-3 text-sm">
                <dt className="text-muted-foreground">Task</dt>
                <dd className="flex items-center gap-2">
                  <select
                    value={s.taskId ?? ""}
                    onChange={(e) => assign.mutate({ taskId: e.target.value || null })}
                    aria-label="Task"
                    className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— Unassigned —</option>
                    {tasks.data?.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                  {s.taskId ? (
                    <LabeledIconButton
                      icon={<ArrowUpRight />}
                      label="Open"
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenTask(s.taskId as string)}
                    />
                  ) : null}
                </dd>

                <dt className="text-muted-foreground">Project</dt>
                <dd>
                  <select
                    value={s.projectId ?? ""}
                    onChange={(e) => assign.mutate({ projectId: e.target.value || null })}
                    aria-label="Project"
                    className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— Unassigned —</option>
                    {projects.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </dd>

                <dt className="text-muted-foreground">Fleet</dt>
                <dd>
                  <select
                    value={s.fleetId ?? ""}
                    onChange={(e) => assign.mutate({ fleetId: e.target.value || null })}
                    aria-label="Fleet"
                    className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— None —</option>
                    {fleets.data?.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </dd>
              </dl>
            </section>

            {/* History */}
            <section className="border-t border-border pt-5">
              <h3 className="mb-3 text-sm font-medium">History</h3>
              <SessionTranscript sessionId={sessionId} />
            </section>
          </div>
        )}

        {confirmDelete ? (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
            <div className="w-full max-w-sm rounded-lg border border-red-500/40 bg-card p-5">
              <div className="flex items-center gap-2 text-red-400">
                <Trash2 className="size-5" />
                <h3 className="text-sm font-semibold">Delete this session?</h3>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Removes the Cadence session record and its event timeline. If it’s still running it will be
                stopped first. The on-disk Claude transcript is not deleted.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <LabeledIconButton
                  icon={<X />}
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                />
                <LabeledIconButton
                  icon={<Trash2 />}
                  label="Delete session"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setConfirmDelete(false);
                    del.mutate();
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
