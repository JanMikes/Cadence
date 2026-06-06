import type { Task } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { createTask, getTasks } from "../../lib/api";

export function Inbox() {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");

  const tasks = useQuery({ queryKey: ["tasks", "inbox"], queryFn: () => getTasks("inbox") });

  const capture = useMutation({
    mutationFn: (t: string) => createTask({ title: t }),
    onSuccess: () => {
      setTitle("");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (t && !capture.isPending) capture.mutate(t);
  };

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Capture anything — refine it later. New tasks land here.
      </p>

      <form onSubmit={onSubmit} className="mt-5 flex gap-2">
        {/* biome-ignore lint/a11y/noAutofocus: capture-first is the point of the Inbox */}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Capture a task…"
          autoFocus
          aria-label="Capture a task"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <LabeledIconButton
          icon={<Plus />}
          label="Capture"
          type="submit"
          disabled={!title.trim() || capture.isPending}
        />
      </form>

      {capture.isError ? (
        <p className="mt-2 text-xs text-red-400">Couldn’t capture — is the gateway running?</p>
      ) : null}

      <ul className="mt-6 flex flex-col gap-2">
        {tasks.isLoading ? <li className="text-sm text-muted-foreground">Loading…</li> : null}
        {tasks.isError ? (
          <li className="text-sm text-red-400">Couldn’t load tasks (is the gateway running?)</li>
        ) : null}
        {tasks.data && tasks.data.length === 0 ? (
          <li className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No tasks yet — capture your first above.
          </li>
        ) : null}
        {tasks.data?.map((task) => <TaskRow key={task.id} task={task} />)}
      </ul>
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li className="rounded-md border border-border bg-card/50 px-4 py-3">
      <div className="text-sm font-medium">{task.title}</div>
      {task.body ? (
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{task.body}</div>
      ) : null}
    </li>
  );
}
