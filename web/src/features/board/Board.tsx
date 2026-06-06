import type { Task } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useState } from "react";
import { getTasks, updateTask } from "../../lib/api";
import { BOARD_COLUMNS, type StatusColumn } from "../../lib/status";
import { cn } from "../../lib/utils";

export function Board({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  // Within each column, surface the most urgent (overdue / due-soon) cards first.
  const tasks = useQuery({
    queryKey: ["tasks", "all", "urgency"],
    queryFn: () => getTasks({ sort: "urgency" }),
  });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateTask(id, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const byStatus = (status: string) => tasks.data?.filter((t) => t.status === status) ?? [];

  return (
    <div className="flex h-full flex-col p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Drag a card to change its status. Click a card to open it.
      </p>

      {tasks.isError ? (
        <p className="mt-4 text-sm text-red-400">Couldn’t load tasks (is the gateway running?)</p>
      ) : null}

      <div className="mt-4 flex flex-1 gap-3 overflow-x-auto pb-4">
        {BOARD_COLUMNS.map((col) => (
          <Column
            key={col.id}
            col={col}
            tasks={byStatus(col.id)}
            onDropTask={(id) => id && move.mutate({ id, status: col.id })}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  col,
  tasks,
  onDropTask,
  onOpen,
}: {
  col: StatusColumn;
  tasks: Task[];
  onDropTask: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [over, setOver] = useState(false);

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropTask(e.dataTransfer.getData("text/plain"));
      }}
      className={cn(
        "flex w-64 shrink-0 flex-col rounded-lg border border-border bg-card/30 p-2 transition-colors",
        over && "ring-2 ring-ring",
      )}
    >
      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
        <span>{col.label}</span>
        <span className="rounded bg-muted px-1.5 py-0.5">{tasks.length}</span>
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {tasks.map((task) => (
          <BoardCard key={task.id} task={task} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

const URGENCY_BADGE: Record<string, { label: string; className: string }> = {
  overdue: { label: "Overdue", className: "bg-red-500/15 text-red-400" },
  due_soon: { label: "Due soon", className: "bg-amber-500/15 text-amber-400" },
};

function BoardCard({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  const onDragStart = (e: DragEvent) => e.dataTransfer.setData("text/plain", task.id);
  const badge = task.urgencyTier ? URGENCY_BADGE[task.urgencyTier] : undefined;
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={() => onOpen(task.id)}
      className="cursor-grab rounded-md border border-border bg-card px-3 py-2 text-left hover:border-primary/50 active:cursor-grabbing"
    >
      <div className="text-sm font-medium">{task.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {badge ? (
          <span className={cn("rounded px-1.5 py-0.5 font-medium", badge.className)}>{badge.label}</span>
        ) : null}
        {task.priority ? <span>{task.priority}</span> : null}
        {task.deadline ? <span>⏷ {new Date(task.deadline).toLocaleDateString()}</span> : null}
      </div>
    </button>
  );
}
