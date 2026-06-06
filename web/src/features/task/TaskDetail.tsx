import { PERMISSION_MODES, TASK_STATUSES } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Play, ShieldAlert, X } from "lucide-react";
import { type FormEvent, useState } from "react";

const PERMISSION_LABELS: Record<string, string> = {
  auto: "Auto",
  manual: "Manual",
  dangerous: "Dangerous",
};
import { LabeledIconButton } from "../../components/LabeledIconButton";
import {
  appendContext,
  getContext,
  getProjects,
  getTaskDetail,
  getTaskSessions,
  playTask,
  spawnSession,
  updateTask,
} from "../../lib/api";
import { statusLabel } from "../../lib/status";
import { QACards } from "../qa/QACards";
import { SuggestionList } from "../suggestions/SuggestionControl";
import { PlanView } from "./PlanView";
import { ReviewPanel } from "./ReviewPanel";
import { StatusTimeline } from "./StatusTimeline";

export function TaskDetail({
  taskId,
  onClose,
  onOpenSession,
}: {
  taskId: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [confirmDangerous, setConfirmDangerous] = useState(false);

  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => getTaskDetail(taskId) });
  const context = useQuery({
    queryKey: ["task", taskId, "context"],
    queryFn: () => getContext(taskId),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });

  const invalidateTask = () => {
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const setStatus = useMutation({
    mutationFn: (status: string) => updateTask(taskId, { status }),
    onSuccess: invalidateTask,
  });

  const setProject = useMutation({
    mutationFn: (slug: string | null) => updateTask(taskId, { project: slug }),
    onSuccess: invalidateTask,
  });

  const setPermission = useMutation({
    mutationFn: (mode: string | null) => updateTask(taskId, { permissionMode: mode }),
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

  const task = detail.data;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-[440px] max-w-full flex-col overflow-auto border-l border-border bg-background p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {task?.title ?? (detail.isLoading ? "Loading…" : "Task")}
          </h2>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>

        {task ? (
          <>
            <QACards taskId={taskId} onResolved={invalidateTask} />

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

              <dt className="text-muted-foreground">Priority</dt>
              <dd>{task.priority ?? "—"}</dd>

              <dt className="text-muted-foreground">Deadline</dt>
              <dd>{task.deadline ? new Date(task.deadline).toLocaleDateString() : "—"}</dd>

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

            {["implementing", "verifying", "review", "done"].includes(task.status) ? (
              <PlanView taskId={taskId} />
            ) : null}

            {task.status === "review" ? (
              <ReviewPanel taskId={taskId} onChanged={invalidateTask} />
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
                      onClick={() => onOpenSession(s.id)}
                      className="flex w-full items-center justify-between rounded-md border border-border bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary/50"
                    >
                      <span className="font-mono">{s.id.slice(0, 8)}</span>
                      <span className="text-muted-foreground">
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

              <div className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card/50 p-3 text-xs text-muted-foreground">
                {context.data?.content?.trim() ? context.data.content.trim() : "No context yet."}
              </div>

              <form onSubmit={onAddNote} className="mt-3 flex flex-col gap-2">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a context note…"
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
      </aside>
    </div>
  );
}
