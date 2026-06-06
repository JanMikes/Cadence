import { TASK_STATUSES } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { appendContext, getContext, getProjects, getTaskDetail, updateTask } from "../../lib/api";
import { statusLabel } from "../../lib/status";

export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");

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

              <dt className="text-muted-foreground">Priority</dt>
              <dd>{task.priority ?? "—"}</dd>

              <dt className="text-muted-foreground">Deadline</dt>
              <dd>{task.deadline ? new Date(task.deadline).toLocaleDateString() : "—"}</dd>

              <dt className="text-muted-foreground">Estimate</dt>
              <dd>{task.estimate != null ? `${task.estimate} min` : "—"}</dd>

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
          </>
        ) : detail.isError ? (
          <p className="mt-6 text-sm text-red-400">Couldn’t load this task.</p>
        ) : null}
      </aside>
    </div>
  );
}
