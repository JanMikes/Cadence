import type { Project, Task, TaskGitContext } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronsUp, ChevronUp, Equal, ListFilter } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { stageLabel, useActivityInfo } from "../../lib/activity";
import { formatDate, useDateFormats } from "../../lib/datetime";
import { getProjects, getTasks } from "../../lib/api";
import { gitStateLabel } from "../../lib/git";
import { BOARD_COLUMNS, type StatusColumn } from "../../lib/status";
import { cn } from "../../lib/utils";
import { useAttention } from "../attention/useAttention";

/** Sentinel for tasks without a project in the filter (they're first-class too). */
const NO_PROJECT = "none";

// Per-column accent (border-top + header dot). Color = meaning, not decoration:
//   gray    = raw, untouched            (inbox)
//   indigo  = filed by triage           (triaged)
//   cool    = Cadence is working        (refining cyan · implementing blue · verifying teal)
//   warm    = waiting on YOU            (needs_feedback amber · plan_review violet · review rose)
//   green   = go / shipped              (ready green — matches PLAY · done emerald)
const COLUMN_ACCENTS: Record<string, { border: string; dot: string }> = {
  inbox: { border: "border-t-zinc-400/80", dot: "bg-zinc-400" },
  triaged: { border: "border-t-indigo-400/80", dot: "bg-indigo-400" },
  refining: { border: "border-t-cyan-400/80", dot: "bg-cyan-400" },
  needs_feedback: { border: "border-t-amber-400/80", dot: "bg-amber-400" },
  ready: { border: "border-t-green-400/80", dot: "bg-green-400" },
  plan_review: { border: "border-t-violet-400/80", dot: "bg-violet-400" },
  implementing: { border: "border-t-blue-400/80", dot: "bg-blue-400" },
  verifying: { border: "border-t-teal-400/80", dot: "bg-teal-400" },
  review: { border: "border-t-rose-400/80", dot: "bg-rose-400" },
  done: { border: "border-t-emerald-400/80", dot: "bg-emerald-400" },
};

export function Board({ onOpen }: { onOpen: (id: string) => void }) {
  // Within each column, surface the most urgent (overdue / due-soon) cards first.
  const tasks = useQuery({
    queryKey: ["tasks", "all", "urgency"],
    queryFn: () => getTasks({ sort: "urgency" }),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  // Stalled = the server's verdict (same feed as the Attention pill) — the one
  // source that actually knows whether a live run exists. A client-side guess from
  // `updatedAt` lied both ways (any unrelated edit hid a real stall for a minute).
  const attention = useAttention();
  const stalledIds = useMemo(
    () =>
      new Set(
        (attention.data?.items ?? [])
          .filter((i) => i.kind === "stalled" && i.taskId)
          .map((i) => i.taskId as string),
      ),
    [attention.data],
  );

  // Project filter: empty selection (the initial state) = all projects.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Type filter (§6.5.g): reviews flow the same board; this narrows when needed.
  const [typeFilter, setTypeFilter] = useState<"all" | "standard" | "code_review">("all");
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

  const visible = useMemo(() => {
    let all = tasks.data ?? [];
    if (typeFilter !== "all") {
      all = all.filter((t) =>
        typeFilter === "code_review" ? t.taskType === "code_review" : t.taskType !== "code_review",
      );
    }
    if (selected.size === 0) return all;
    return all.filter((t) => selected.has(t.projectId ?? NO_PROJECT));
  }, [tasks.data, selected, typeFilter]);

  const byStatus = (status: string) => visible.filter((t) => t.status === status);

  return (
    <div className="flex h-full flex-col p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Click a card to open it — statuses move through the flow (PLAY · approve · merge), not by hand.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Task type" className="flex overflow-hidden rounded-md border border-border text-xs">
            {(
              [
                ["all", "All"],
                ["standard", "Tasks"],
                ["code_review", "Reviews"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTypeFilter(id)}
                className={cn(
                  "px-2.5 py-1 transition-colors",
                  typeFilter === id
                    ? "bg-primary/15 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-card",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <ProjectFilter
            projects={projects.data ?? []}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected(new Set())}
            shown={visible.length}
            total={tasks.data?.length ?? 0}
          />
        </div>
      </div>

      {tasks.isError ? (
        <p className="mt-4 text-sm text-red-400">Couldn’t load tasks (is the gateway running?)</p>
      ) : null}

      <div className="mt-4 flex min-h-0 flex-1 gap-3 overflow-x-auto">
        {BOARD_COLUMNS.map((col) => (
          <Column
            key={col.id}
            col={col}
            tasks={byStatus(col.id)}
            projectById={projectById}
            stalledIds={stalledIds}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The board's project filter (§10.1 — plain language, self-explanatory): a labeled
 * dropdown (projects can be many) holding one checkbox per project plus "No
 * project". Nothing checked (the default) means every task is shown; Clear
 * returns to that state. `defaultOpen` exists for static rendering in tests.
 */
export function ProjectFilter({
  projects,
  selected,
  onToggle,
  onClear,
  shown,
  total,
  defaultOpen = false,
}: {
  projects: Project[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
  shown: number;
  total: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const filtering = selected.size > 0;

  // Esc closes the dropdown (matching the app's modal behavior).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const summary = !filtering
    ? "All projects"
    : selected.size === 1
      ? (projects.find((p) => selected.has(p.id))?.name ?? "No project")
      : `${selected.size} selected`;

  return (
    <div className="relative flex items-center gap-2">
      {filtering ? (
        <span className="text-xs text-muted-foreground">
          {shown} of {total} tasks
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
          filtering
            ? "border-primary/60 bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
        )}
      >
        <ListFilter className="size-4" aria-hidden />
        <span>
          Projects: <span className="font-medium text-foreground">{summary}</span>
        </span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {filtering ? (
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          Clear
        </button>
      ) : null}

      {open ? (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (handler above); backdrop is a convenience */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-xl">
            <FilterRow
              label="No project"
              color={null}
              checked={selected.has(NO_PROJECT)}
              onToggle={() => onToggle(NO_PROJECT)}
            />
            {projects.length ? <div className="mx-2 my-1 border-t border-border" /> : null}
            {projects.map((p) => (
              <FilterRow
                key={p.id}
                label={p.name}
                color={p.color}
                checked={selected.has(p.id)}
                onToggle={() => onToggle(p.id)}
              />
            ))}
            <div className="mx-2 my-1 border-t border-border" />
            <button
              type="button"
              disabled={!filtering}
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              Clear — show all projects
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** One dropdown row — a real checkbox plus the project's color dot + name. */
function FilterRow({
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
        "flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-muted",
        checked ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} className="size-3.5 accent-primary" />
      <span
        className="size-2 shrink-0 rounded-full border border-border bg-muted-foreground/30"
        style={color ? { backgroundColor: color, borderColor: color } : undefined}
        aria-hidden
      />
      <span className="truncate">{label}</span>
    </label>
  );
}

function Column({
  col,
  tasks,
  projectById,
  stalledIds,
  onOpen,
}: {
  col: StatusColumn;
  tasks: Task[];
  projectById: Map<string, Project>;
  stalledIds: ReadonlySet<string>;
  onOpen: (id: string) => void;
}) {
  const accent = COLUMN_ACCENTS[col.id] ?? { border: "border-t-border", dot: "bg-muted-foreground" };

  return (
    <section
      className={cn(
        "flex w-64 shrink-0 flex-col rounded-lg border border-border border-t-2 bg-card/30 p-2",
        accent.border,
      )}
    >
      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 rounded-full", accent.dot)} />
          {col.label}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5">{tasks.length}</span>
      </div>
      <div className="mt-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {tasks.map((task) => (
          <BoardCard
            key={task.id}
            task={task}
            project={task.projectId ? projectById.get(task.projectId) : undefined}
            stalled={stalledIds.has(task.id)}
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
// obvious even when scanning a column (colors match the column accents above).
const ATTENTION_BADGE: Record<string, { label: string; className: string }> = {
  needs_feedback: { label: "Needs input", className: "bg-amber-500/20 text-amber-300" },
  plan_review: { label: "Approve plan", className: "bg-violet-500/20 text-violet-300" },
  review: { label: "Review & merge", className: "bg-rose-500/20 text-rose-300" },
};

// Jira-style priority marks: arrow + color + plain word instead of a cryptic "P1" string.
// Words match the Add-task / Recurring pickers ("Critical (P0)" …) — one vocabulary app-wide.
const PRIORITY_GLYPHS: Record<string, { node: React.ReactNode; text: string; label: string; tint: string }> = {
  p0: {
    node: <ChevronsUp className="size-3.5" strokeWidth={3} aria-hidden />,
    text: "Critical",
    label: "Critical (P0)",
    tint: "text-red-400",
  },
  p1: {
    node: <ChevronUp className="size-3.5" strokeWidth={3} aria-hidden />,
    text: "High",
    label: "High (P1)",
    tint: "text-orange-400",
  },
  p2: {
    node: <Equal className="size-3.5" strokeWidth={3} aria-hidden />,
    text: "Normal",
    label: "Normal (P2)",
    tint: "text-amber-300",
  },
  p3: {
    node: <ChevronDown className="size-3.5" strokeWidth={3} aria-hidden />,
    text: "Low",
    label: "Low (P3)",
    tint: "text-sky-400",
  },
};

/** Free-text priorities a model/user might write, mapped onto the P0..P3 glyphs. */
const PRIORITY_ALIASES: Record<string, string> = {
  highest: "p0",
  urgent: "p0",
  critical: "p0",
  high: "p1",
  medium: "p2",
  med: "p2",
  normal: "p2",
  low: "p3",
  lowest: "p3",
};

/** Jira-style priority marker (arrow + color + plain word); falls back to the raw text. */
export function PriorityBadge({ priority }: { priority: string }) {
  const key = priority.trim().toLowerCase();
  const glyph = PRIORITY_GLYPHS[key] ?? PRIORITY_GLYPHS[PRIORITY_ALIASES[key] ?? ""];
  if (!glyph) return <span>{priority}</span>;
  return (
    <span
      title={`Priority: ${glyph.label}`}
      aria-label={`Priority: ${glyph.label}`}
      className={cn("inline-flex items-center gap-0.5 font-medium", glyph.tint)}
    >
      {glyph.node}
      {glyph.text}
    </span>
  );
}

/**
 * The card's git-outcome chip (review/done columns only — earlier the branch doesn't
 * exist yet). Loud only when it carries a verdict: green = the work landed on base,
 * amber = a done task whose branch never merged (the honest alarm this chip exists
 * for). A review task that simply isn't merged yet is the normal state — no chip.
 */
export function GitChip({ ctx, status }: { ctx: TaskGitContext; status: string }) {
  const title = `${gitStateLabel(ctx)}${ctx.branch ? ` · ${ctx.branch}` : ""}`;
  if (ctx.kind === "direct") {
    return (
      <span title={title} className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
        → {ctx.baseBranch ?? "branch"}
      </span>
    );
  }
  if (ctx.merged === "merged") {
    return (
      <span title={title} className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-400">
        ⎇ Merged{ctx.baseBranch ? ` → ${ctx.baseBranch}` : ""}
      </span>
    );
  }
  if (status !== "done") return null; // unmerged-in-review is the expected state, not news
  if (ctx.merged === "unmerged") {
    return (
      <span title={title} className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-400">
        ⎇ Not merged
      </span>
    );
  }
  if (ctx.merged === "branch_gone") {
    return (
      <span title={title} className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-300/80">
        ⎇ Branch gone
      </span>
    );
  }
  return null;
}

/** Quiet provenance, not a shout: a dot in the project's color + its name. */
export function ProjectChip({ project }: { project: Project }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/50 px-1.5 py-0.5 text-[10px]">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
        style={project.color ? { backgroundColor: project.color } : undefined}
      />
      <span className="truncate">{project.name}</span>
    </span>
  );
}

/** A small inline spinner shown while an autonomy stage is working a task.
 *  "queued" renders muted (gray, slower spin, "Waiting for …") — the task isn't
 *  being worked, it's in line behind whatever `detail` names (never lie about state). */
export function WorkingSpinner({
  stage,
  detail,
  className,
}: {
  stage: string;
  detail?: string | null;
  className?: string;
}) {
  const waiting = stage === "queued";
  const caption = waiting && detail ? `Waiting for ${detail}` : stageLabel(stage);
  return (
    <span
      title={caption}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5",
        waiting ? "text-muted-foreground" : "text-primary",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-3 shrink-0 animate-spin rounded-full border-2",
          waiting
            ? "border-muted-foreground/30 border-t-muted-foreground [animation-duration:1.6s]"
            : "border-primary/30 border-t-primary",
        )}
      />
      <span className="truncate">{caption}</span>
    </span>
  );
}

function BoardCard({
  task,
  project,
  stalled,
  onOpen,
}: {
  task: Task;
  project?: Project;
  /** Server verdict from the attention feed — a run died and nothing is moving this task. */
  stalled: boolean;
  onOpen: (id: string) => void;
}) {
  const fmts = useDateFormats();
  const badge = task.urgencyTier ? URGENCY_BADGE[task.urgencyTier] : undefined;
  const attention = ATTENTION_BADGE[task.status];
  const activity = useActivityInfo(task.id);
  const stage = activity?.stage ?? null;
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className={cn(
        "rounded-md border border-border bg-card px-3 py-2 text-left hover:border-primary/50",
        // queued = in line, not being worked — no "agent active" tint for it
        stage && stage !== "queued" && "border-primary/40",
        stalled && "border-red-500/50",
      )}
    >
      <div className="text-sm font-medium">{task.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {stage ? <WorkingSpinner stage={stage} detail={activity?.detail} /> : null}
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
        {task.taskType === "code_review" ? (
          <span
            title={
              task.reviewDirection === "address"
                ? "Code review — addressing feedback on my PR/MR"
                : "Code review — reviewing their PR/MR"
            }
            className="rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-violet-300"
          >
            ⇄ Review
          </span>
        ) : null}
        {task.gitContext && (task.status === "review" || task.status === "done") ? (
          <GitChip ctx={task.gitContext} status={task.status} />
        ) : null}
        {task.priority ? <PriorityBadge priority={task.priority} /> : null}
        {task.deadline ? <span>⏷ {formatDate(task.deadline, fmts)}</span> : null}
        {task.prUrl ? (
          // The card root is a <button>, so this is a styled span (nested <a> is invalid HTML).
          <span
            role="link"
            tabIndex={0}
            title="Open the PR/MR this task delivered"
            onClick={(e) => {
              e.stopPropagation();
              window.open(task.prUrl as string, "_blank", "noreferrer");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                window.open(task.prUrl as string, "_blank", "noreferrer");
              }
            }}
            className="text-primary hover:underline"
          >
            PR ↗
          </span>
        ) : null}
        {project ? <ProjectChip project={project} /> : null}
      </div>
    </button>
  );
}
