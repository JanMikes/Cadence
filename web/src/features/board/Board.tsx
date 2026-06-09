import type { Project, Task } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useMemo, useState } from "react";
import { useActivity, stageLabel } from "../../lib/activity";
import { getProjects, getTasks, updateTask } from "../../lib/api";
import { BOARD_COLUMNS, type StatusColumn } from "../../lib/status";
import { cn } from "../../lib/utils";

/** Sentinel for tasks without a project in the filter (they're first-class too). */
const NO_PROJECT = "none";

// Per-column accent (border-top + header dot): a rainbow sweep across the
// lifecycle so each stage is recognizable at a glance, pinned to the existing
// semantic badge colors (needs_feedback amber · plan_review violet · review green).
const COLUMN_ACCENTS: Record<string, { border: string; dot: string }> = {
  inbox: { border: "border-t-zinc-400/80", dot: "bg-zinc-400" },
  triaged: { border: "border-t-sky-400/80", dot: "bg-sky-400" },
  refining: { border: "border-t-cyan-400/80", dot: "bg-cyan-400" },
  needs_feedback: { border: "border-t-amber-400/80", dot: "bg-amber-400" },
  ready: { border: "border-t-lime-400/80", dot: "bg-lime-400" },
  plan_review: { border: "border-t-violet-400/80", dot: "bg-violet-400" },
  implementing: { border: "border-t-blue-400/80", dot: "bg-blue-400" },
  verifying: { border: "border-t-orange-400/80", dot: "bg-orange-400" },
  review: { border: "border-t-green-400/80", dot: "bg-green-400" },
  done: { border: "border-t-emerald-400/80", dot: "bg-emerald-400" },
};

export function Board({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  // Within each column, surface the most urgent (overdue / due-soon) cards first.
  const tasks = useQuery({
    queryKey: ["tasks", "all", "urgency"],
    queryFn: () => getTasks({ sort: "urgency" }),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });

  // Project filter: empty selection (the initial state) = all projects.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const projectById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateTask(id, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const visible = useMemo(() => {
    const all = tasks.data ?? [];
    if (selected.size === 0) return all;
    return all.filter((t) => selected.has(t.projectId ?? NO_PROJECT));
  }, [tasks.data, selected]);

  const byStatus = (status: string) => visible.filter((t) => t.status === status);

  return (
    <div className="flex h-full flex-col p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Drag a card to change its status. Click a card to open it.
      </p>

      <ProjectFilter
        projects={projects.data ?? []}
        selected={selected}
        onToggle={toggle}
        onClear={() => setSelected(new Set())}
        shown={visible.length}
        total={tasks.data?.length ?? 0}
      />

      {tasks.isError ? (
        <p className="mt-4 text-sm text-red-400">Couldn’t load tasks (is the gateway running?)</p>
      ) : null}

      <div className="mt-4 flex flex-1 gap-3 overflow-x-auto pb-4">
        {BOARD_COLUMNS.map((col) => (
          <Column
            key={col.id}
            col={col}
            tasks={byStatus(col.id)}
            projectById={projectById}
            onDropTask={(id) => id && move.mutate({ id, status: col.id })}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The board's project filter (§10.1 — plain language, self-explanatory): a row of
 * labeled checkboxes, one per project plus "No project". Nothing checked (the
 * default) means every task is shown; "Clear" returns to that state.
 */
function ProjectFilter({
  projects,
  selected,
  onToggle,
  onClear,
  shown,
  total,
}: {
  projects: Project[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
  shown: number;
  total: number;
}) {
  const filtering = selected.size > 0;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Projects:</span>
      {projects.map((p) => (
        <FilterCheckbox
          key={p.id}
          label={p.name}
          color={p.color}
          checked={selected.has(p.id)}
          onToggle={() => onToggle(p.id)}
        />
      ))}
      <FilterCheckbox
        label="No project"
        color={null}
        checked={selected.has(NO_PROJECT)}
        onToggle={() => onToggle(NO_PROJECT)}
      />
      {filtering ? (
        <>
          <span className="text-xs text-muted-foreground">
            {shown} of {total} tasks
          </span>
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            Clear
          </button>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">All projects</span>
      )}
    </div>
  );
}

/** One labeled filter pill — a real checkbox plus the project's color dot + name. */
function FilterCheckbox({
  label,
  color,
  checked,
  onToggle,
}: {
  label: string;
  color: string | null;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        checked
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} className="size-3 accent-primary" />
      <span
        className="size-2 rounded-full border border-border bg-muted-foreground/30"
        style={color ? { backgroundColor: color, borderColor: color } : undefined}
        aria-hidden
      />
      {label}
    </label>
  );
}

function Column({
  col,
  tasks,
  projectById,
  onDropTask,
  onOpen,
}: {
  col: StatusColumn;
  tasks: Task[];
  projectById: Map<string, Project>;
  onDropTask: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const accent = COLUMN_ACCENTS[col.id] ?? { border: "border-t-border", dot: "bg-muted-foreground" };

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
        "flex w-64 shrink-0 flex-col rounded-lg border border-border border-t-2 bg-card/30 p-2 transition-colors",
        accent.border,
        over && "ring-2 ring-ring",
      )}
    >
      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 rounded-full", accent.dot)} />
          {col.label}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5">{tasks.length}</span>
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {tasks.map((task) => (
          <BoardCard
            key={task.id}
            task={task}
            project={task.projectId ? projectById.get(task.projectId) : undefined}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

const URGENCY_BADGE: Record<string, { label: string; className: string }> = {
  overdue: { label: "Overdue", className: "bg-red-500/15 text-red-400" },
  due_soon: { label: "Due soon", className: "bg-amber-500/15 text-amber-400" },
};

// A loud, labeled chip for cards that are waiting on the user — so "needs you" is
// obvious even when scanning a column (it also reinforces the Plan review column).
const ATTENTION_BADGE: Record<string, { label: string; className: string }> = {
  needs_feedback: { label: "Needs input", className: "bg-amber-500/20 text-amber-300" },
  plan_review: { label: "Approve plan", className: "bg-violet-500/20 text-violet-300" },
  review: { label: "Review & merge", className: "bg-green-500/20 text-green-300" },
};

/** A small inline spinner shown while an autonomy stage is working a task. */
export function WorkingSpinner({ stage, className }: { stage: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-primary", className)}>
      <span
        aria-hidden
        className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
      />
      {stageLabel(stage)}
    </span>
  );
}

function BoardCard({
  task,
  project,
  onOpen,
}: {
  task: Task;
  project?: Project;
  onOpen: (id: string) => void;
}) {
  const onDragStart = (e: DragEvent) => e.dataTransfer.setData("text/plain", task.id);
  const badge = task.urgencyTier ? URGENCY_BADGE[task.urgencyTier] : undefined;
  const attention = ATTENTION_BADGE[task.status];
  const stage = useActivity(task.id);
  // An active-work card with no live run (and not just dispatched) is stalled — show it loudly
  // rather than letting it masquerade as "in progress" with nothing happening.
  const stalled =
    !stage &&
    (task.status === "implementing" || task.status === "verifying") &&
    Date.now() - task.updatedAt > 60_000;
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={() => onOpen(task.id)}
      className={cn(
        "cursor-grab rounded-md border border-border bg-card px-3 py-2 text-left hover:border-primary/50 active:cursor-grabbing",
        stage && "border-primary/40",
        stalled && "border-red-500/50",
      )}
    >
      <div className="text-sm font-medium">{task.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {stage ? <WorkingSpinner stage={stage} /> : null}
        {stalled ? (
          <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-medium text-red-300">⚠ Stalled</span>
        ) : null}
        {!stage && attention ? (
          <span className={cn("rounded px-1.5 py-0.5 font-medium", attention.className)}>
            {attention.label}
          </span>
        ) : null}
        {badge ? (
          <span className={cn("rounded px-1.5 py-0.5 font-medium", badge.className)}>{badge.label}</span>
        ) : null}
        {task.priority ? <span>{task.priority}</span> : null}
        {task.deadline ? <span>⏷ {new Date(task.deadline).toLocaleDateString()}</span> : null}
        {project ? (
          // Quiet provenance, not a shout: a dot in the project's color + its name.
          <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/50 px-1.5 py-0.5 text-[10px]">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
              style={project.color ? { backgroundColor: project.color } : undefined}
            />
            <span className="truncate">{project.name}</span>
          </span>
        ) : null}
      </div>
    </button>
  );
}
