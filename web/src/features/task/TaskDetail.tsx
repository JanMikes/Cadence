import { DELIVERY_MODE_INFO, DELIVERY_MODES, deliveryModeLabel, PERMISSION_MODES, TASK_STATUSES } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitMerge, MessageSquarePlus, Play, RotateCcw, ShieldAlert, X } from "lucide-react";
import { type ClipboardEvent, type FormEvent, useState } from "react";

const PERMISSION_LABELS: Record<string, string> = {
  auto: "Auto",
  manual: "Manual",
  dangerous: "Dangerous",
};
import { type FlowControls, FlowStrip } from "../../components/FlowStrip";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { toast } from "../../components/Toaster";
import {
  appendContext,
  getContext,
  getFleets,
  getProjects,
  getTaskDetail,
  getTaskSessions,
  playTask,
  recheckGitContext,
  spawnSession,
  updateTask,
} from "../../lib/api";
import { formatDate, formatDateTime, useDateFormats } from "../../lib/datetime";
import { gitStateLabel, gitStateTone } from "../../lib/git";
import { roleLabel, statusLabel } from "../../lib/status";
import { AttachmentsSection, eventFiles, useAttachmentUpload } from "./Attachments";
import { QACards } from "../qa/QACards";
import { SuggestionList } from "../suggestions/SuggestionControl";
import { ReviewWorkspace } from "../review/ReviewWorkspace";
import { DeliveryRecord } from "./DeliveryRecord";
import { PlanView } from "./PlanView";
import { RelationsPanel } from "./RelationsPanel";
import { ReviewPanel } from "./ReviewPanel";
import { RunReports } from "./RunReports";
import { StatusTimeline } from "./StatusTimeline";

export function TaskDetail({
  taskId,
  onClose,
  onOpenSession,
  onOpenSessionDetail,
  onOpenTask,
  flow,
  onResolved,
}: {
  taskId: string;
  onClose: () => void;
  /** Open the live chat panel (used right after spawning a fresh session). */
  onOpenSession: (sessionId: string) => void;
  /** Open the rich session detail drawer (used when clicking an existing session). */
  onOpenSessionDetail?: (sessionId: string) => void;
  onOpenTask?: (taskId: string) => void;
  /** When opened as a step in the Attention flow: shows the flow strip + enables auto-advance. */
  flow?: FlowControls;
  /** Called after a resolve action here (answer/approve/merge) — drives the flow's advance. */
  onResolved?: () => void;
}) {
  const fmts = useDateFormats();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [confirmDangerous, setConfirmDangerous] = useState(false);

  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => getTaskDetail(taskId) });
  const context = useQuery({
    queryKey: ["task", taskId, "context"],
    queryFn: () => getContext(taskId),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const fleets = useQuery({ queryKey: ["fleets"], queryFn: getFleets });

  const invalidateTask = () => {
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  // In the Attention flow, a successful resolve here (answered Q&A / approved plan / merged)
  // advances to the next item; standalone it's just a refresh.
  const resolved = () => {
    invalidateTask();
    onResolved?.();
  };

  const setStatus = useMutation({
    mutationFn: (status: string) => updateTask(taskId, { status }),
    onSuccess: invalidateTask,
  });

  const setProject = useMutation({
    mutationFn: (slug: string | null) => updateTask(taskId, { project: slug }),
    onSuccess: invalidateTask,
  });

  const setFleet = useMutation({
    mutationFn: (slug: string | null) => updateTask(taskId, { fleet: slug }),
    onSuccess: invalidateTask,
  });

  const setPermission = useMutation({
    mutationFn: (mode: string | null) => updateTask(taskId, { permissionMode: mode }),
    onSuccess: invalidateTask,
  });

  const setDelivery = useMutation({
    mutationFn: (mode: string | null) => updateTask(taskId, { deliveryMode: mode }),
    onSuccess: invalidateTask,
  });

  const onPermissionChange = (value: string) => {
    if (value === "dangerous") {
      setConfirmDangerous(true); // gate Dangerous behind a confirm (§9.1)
    } else {
      setPermission.mutate(value || null);
    }
  };

  const sessions = useQuery({
    queryKey: ["task", taskId, "sessions"],
    queryFn: () => getTaskSessions(taskId),
  });

  const run = useMutation({
    mutationFn: () => spawnSession(taskId),
    onSuccess: (session) => {
      void qc.invalidateQueries({ queryKey: ["task", taskId, "sessions"] });
      onOpenSession(session.id);
    },
  });

  const play = useMutation({
    mutationFn: () => playTask(taskId),
    onSuccess: invalidateTask,
  });

  // Manual git re-check ("did this merge yet?") — always answers with a toast so
  // the click visibly did something, even when nothing changed.
  const recheckGit = useMutation({
    mutationFn: () => recheckGitContext(taskId),
    onSuccess: (r) => {
      invalidateTask();
      toast(r.changed ? "Git state updated." : "Re-checked — no change.");
    },
  });

  // "Mark done" for work that was merged outside Cadence (the banner below) —
  // propose-don't-impose: the sweep only nudges, this click is the decision.
  const markDone = useMutation({
    mutationFn: () => updateTask(taskId, { status: "done" }),
    onSuccess: (updated) => {
      toast(`🎉 “${updated.title}” merged — task done. Nice ship!`);
      resolved();
      if (!flow) onClose();
    },
  });

  const addNote = useMutation({
    mutationFn: (text: string) => appendContext(taskId, text),
    onSuccess: () => {
      setNote("");
      void qc.invalidateQueries({ queryKey: ["task", taskId, "context"] });
    },
  });

  const onAddNote = (e: FormEvent) => {
    e.preventDefault();
    const t = note.trim();
    if (t && !addNote.isPending) addNote.mutate(t);
  };

  // Pasting a screenshot/file into the note field attaches it (terminal parity:
  // images dropped into claude become context — here via the attachments dir).
  const uploadFiles = useAttachmentUpload(taskId);
  const onNotePaste = (e: ClipboardEvent) => {
    const files = eventFiles(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      uploadFiles.mutate(files);
    }
  };

  const task = detail.data;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {flow ? <FlowStrip flow={flow} /> : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <div className="flex items-start justify-between gap-3">
          <h2 className="flex flex-wrap items-baseline gap-2 text-lg font-semibold tracking-tight">
            {task?.title ?? (detail.isLoading ? "Loading…" : "Task")}
            {task?.titleGenerated ? (
              <span
                title="Captured without a title — the refinement agent will name it"
                className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal text-muted-foreground"
              >
                Auto-named on refine
              </span>
            ) : null}
          </h2>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>

        {task ? (
          <>
            <QACards taskId={taskId} status={task.status} onResolved={resolved} />

            {task.status === "ready" ? (
              <button
                type="button"
                onClick={() => play.mutate()}
                disabled={play.isPending}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-green-600/20 transition-colors hover:bg-green-500 disabled:opacity-60"
              >
                <Play className="size-4 fill-current" />
                {play.isPending ? "Starting…" : "PLAY — implement this task"}
              </button>
            ) : null}
            {play.isError ? (
              <p className="mt-2 text-xs text-red-400">Couldn’t start — is the task still Ready?</p>
            ) : null}

            {/* State's primary action first (importance + context): a task in Review surfaces
                Merge / Request-changes above the now-reference Plan; an approving/executing task
                surfaces its Plan. The reference metadata grid follows below. Code-review tasks
                get the Review Workspace instead of the plan/merge machinery (§6.5.e/f). */}
            {task.taskType === "code_review" ? (
              <ReviewWorkspace task={task} />
            ) : (
              <>
                {task.status === "review" && task.gitContext?.merged === "merged" ? (
                  // The sweep (or a re-check) found this work already merged outside
                  // Cadence — the merge button below would fail; closing is the real action.
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
                    <div className="flex items-center gap-2 text-sm text-emerald-300">
                      <GitMerge className="size-4" aria-hidden />
                      <span>{gitStateLabel(task.gitContext)} — the task just needs closing.</span>
                    </div>
                    <LabeledIconButton
                      icon={<Check />}
                      label="Mark done"
                      size="sm"
                      onClick={() => markDone.mutate()}
                      disabled={markDone.isPending}
                    />
                  </div>
                ) : null}

                {task.status === "review" ? (
                  <ReviewPanel
                    taskId={taskId}
                    onChanged={resolved}
                    onMerged={() => {
                      // Celebrate + get out of the way: toast, and close the modal
                      // when standalone (the Attention flow advances on its own).
                      toast(`🎉 “${task.title}” merged — task done. Nice ship!`);
                      if (!flow) onClose();
                    }}
                    onRequestedChanges={() => {
                      toast("Changes requested — re-implementing with your note.");
                      if (!flow) onClose();
                    }}
                  />
                ) : null}

                {task.status === "done" ? (
                  <DeliveryRecord taskId={taskId} gitContext={task.gitContext} />
                ) : null}

                {["plan_review", "implementing", "verifying", "review", "done"].includes(task.status) ? (
                  <PlanView taskId={taskId} status={task.status} onResolved={resolved} />
                ) : null}
              </>
            )}

            <dl className="mt-5 grid grid-cols-[6rem_1fr] items-center gap-y-3 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <select
                  value={task.status}
                  onChange={(e) => setStatus.mutate(e.target.value)}
                  aria-label="Status"
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s)}
                    </option>
                  ))}
                </select>
              </dd>

              <dt className="text-muted-foreground">Project</dt>
              <dd>
                <select
                  value={projects.data?.find((p) => p.id === task.projectId)?.slug ?? ""}
                  onChange={(e) => setProject.mutate(e.target.value || null)}
                  aria-label="Project"
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">— Unassigned —</option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.slug}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </dd>

              <dt className="text-muted-foreground">Fleet</dt>
              <dd>
                <select
                  value={fleets.data?.find((f) => f.id === task.fleetId)?.slug ?? ""}
                  onChange={(e) => setFleet.mutate(e.target.value || null)}
                  aria-label="Fleet"
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">— None —</option>
                  {fleets.data?.map((f) => (
                    <option key={f.id} value={f.slug}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </dd>

              <dt className="text-muted-foreground">Permission</dt>
              <dd className="flex items-center gap-2">
                <select
                  value={task.permissionMode ?? ""}
                  onChange={(e) => onPermissionChange(e.target.value)}
                  aria-label="Permission mode"
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Inherit</option>
                  {PERMISSION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {PERMISSION_LABELS[m]}
                    </option>
                  ))}
                </select>
                <span
                  className={
                    task.resolvedPermissionMode === "dangerous"
                      ? "text-xs text-red-400"
                      : "text-xs text-muted-foreground"
                  }
                >
                  effective: {PERMISSION_LABELS[task.resolvedPermissionMode] ?? task.resolvedPermissionMode}
                </span>
              </dd>

              <dt className="text-muted-foreground">Delivery</dt>
              <dd className="flex items-center gap-2">
                <select
                  value={task.deliveryMode ?? ""}
                  onChange={(e) => setDelivery.mutate(e.target.value || null)}
                  aria-label="Delivery mode"
                  title={
                    DELIVERY_MODE_INFO[
                      (task.deliveryMode ?? task.resolvedDeliveryMode) as keyof typeof DELIVERY_MODE_INFO
                    ]?.description
                  }
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Inherit</option>
                  {DELIVERY_MODES.map((m) => (
                    <option key={m} value={m} title={DELIVERY_MODE_INFO[m].description}>
                      {DELIVERY_MODE_INFO[m].label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  effective: {deliveryModeLabel(task.resolvedDeliveryMode)}
                </span>
              </dd>

              <dt className="text-muted-foreground">Priority</dt>
              <dd>{task.priority ?? "—"}</dd>

              <dt className="text-muted-foreground">Deadline</dt>
              <dd>{formatDate(task.deadline, fmts)}</dd>

              {task.prUrl ? (
                <>
                  <dt className="text-muted-foreground">PR / MR</dt>
                  <dd>
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      Open PR/MR ↗
                    </a>
                  </dd>
                </>
              ) : null}

              {task.gitContext ? (
                <>
                  <dt className="text-muted-foreground">Git</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    {task.gitContext.branch ? (
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {task.gitContext.branch}
                      </span>
                    ) : null}
                    <span
                      title={`Last checked ${formatDateTime(task.gitContext.checkedAt, fmts)}`}
                      className={
                        {
                          ok: "text-xs text-emerald-400",
                          warn: "text-xs text-amber-400",
                          muted: "text-xs text-muted-foreground",
                        }[gitStateTone(task.gitContext)]
                      }
                    >
                      {gitStateLabel(task.gitContext)}
                    </span>
                    <LabeledIconButton
                      icon={<RotateCcw />}
                      label="Re-check"
                      variant="ghost"
                      size="sm"
                      onClick={() => recheckGit.mutate()}
                      disabled={recheckGit.isPending}
                    />
                  </dd>
                </>
              ) : null}

              <dt className="text-muted-foreground">Estimate</dt>
              <dd>{task.estimate != null ? `${task.estimate} min` : "—"}</dd>

              <dt className="text-muted-foreground">Cost</dt>
              <dd title="Sum of session costs — an effort signal, not a budget">
                ${task.costUsd.toFixed(4)}
              </dd>

              <dt className="text-muted-foreground">Labels</dt>
              <dd className="flex flex-wrap gap-1">
                {task.labels.length ? (
                  task.labels.map((l) => (
                    <span key={l} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {l}
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </dd>
            </dl>

            {task.body ? (
              <p className="mt-5 whitespace-pre-wrap text-sm text-foreground/90">{task.body}</p>
            ) : null}

            <SuggestionList entityType="task" entityId={taskId} />

            <section className="mt-7 border-t border-border pt-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Sessions</h3>
                <LabeledIconButton
                  icon={<Play />}
                  label="Run Claude"
                  size="sm"
                  onClick={() => run.mutate()}
                  disabled={run.isPending}
                />
              </div>
              {run.isError ? (
                <p className="mt-2 text-xs text-red-400">Couldn’t start a session.</p>
              ) : null}
              <ul className="mt-3 flex flex-col gap-1.5">
                {sessions.data?.length === 0 ? (
                  <li className="text-xs text-muted-foreground">No sessions yet.</li>
                ) : null}
                {sessions.data?.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => (onOpenSessionDetail ?? onOpenSession)(s.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary/50"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="font-medium">{roleLabel(s.role)}</span>
                        {s.kind === "oneshot" ? (
                          <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            stage
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {s.status}
                        {s.permissionMode ? ` · ${PERMISSION_LABELS[s.permissionMode] ?? s.permissionMode}` : ""} · $
                        {s.costUsd.toFixed(4)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-7 border-t border-border pt-5">
              <h3 className="text-sm font-medium">Context</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Add free-form context anytime — it’s appended to the task’s context channel.
              </p>

              <AttachmentsSection taskId={taskId} />

              <div className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card/50 p-3 text-xs text-muted-foreground">
                {context.data?.content?.trim() ? context.data.content.trim() : "No context yet."}
              </div>

              <form onSubmit={onAddNote} className="mt-3 flex flex-col gap-2">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onPaste={onNotePaste}
                  placeholder="Add a context note… (paste an image to attach it)"
                  rows={3}
                  aria-label="Add a context note"
                  className="rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="flex justify-end">
                  <LabeledIconButton
                    icon={<MessageSquarePlus />}
                    label="Add note"
                    type="submit"
                    disabled={!note.trim() || addNote.isPending}
                  />
                </div>
              </form>
            </section>

            <RunReports taskId={taskId} />

            <RelationsPanel
              taskId={taskId}
              parentTaskId={task.parentTaskId}
              onOpen={(id) => onOpenTask?.(id)}
            />

            <StatusTimeline taskId={taskId} />
          </>
        ) : detail.isError ? (
          <p className="mt-6 text-sm text-red-400">Couldn’t load this task.</p>
        ) : null}

        {confirmDangerous ? (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
            <div className="w-full max-w-sm rounded-lg border border-red-500/40 bg-card p-5">
              <div className="flex items-center gap-2 text-red-400">
                <ShieldAlert className="size-5" />
                <h3 className="text-sm font-semibold">Enable Dangerous mode?</h3>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Dangerous mode skips <strong>all</strong> permission checks — Claude can edit files and
                run commands without asking. Use only in a trusted, sandboxed working directory.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <LabeledIconButton
                  icon={<X />}
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDangerous(false)}
                />
                <LabeledIconButton
                  icon={<ShieldAlert />}
                  label="Enable Dangerous"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setPermission.mutate("dangerous");
                    setConfirmDangerous(false);
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
}
