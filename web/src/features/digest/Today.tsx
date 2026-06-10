import type { DigestPick, Task } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CalendarCheck,
  Check,
  Flame,
  ListChecks,
  Moon,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { commitDigest, getDigest, getTasks, recapDigest } from "../../lib/api";
import { formatDayKey, useDateFormats } from "../../lib/datetime";
import { cn } from "../../lib/utils";
import { ProgressRing } from "./ProgressRing";
import { SweepPanel } from "./SweepPanel";

const TIER_BADGE: Record<string, { label: string; className: string }> = {
  overdue: { label: "Overdue", className: "bg-red-500/15 text-red-400" },
  due_soon: { label: "Due soon", className: "bg-amber-500/15 text-amber-400" },
  upcoming: { label: "Upcoming", className: "bg-sky-500/15 text-sky-400" },
};

/** The three moments of the daily ritual — rendered as a stepper so the flow is legible. */
const RITUAL_STEPS = [
  {
    id: "planning",
    icon: ListChecks,
    title: "1 · Plan",
    text: "Cadence proposes a shortlist from your open tasks — most urgent first. Reorder, trim, or add.",
  },
  {
    id: "committed",
    icon: CalendarCheck,
    title: "2 · Commit",
    text: "Lock the plan in. Through the day, the ring fills as planned tasks reach Done.",
  },
  {
    id: "recapped",
    icon: Moon,
    title: "3 · Recap",
    text: "In the evening, close the day. Unfinished tasks roll into tomorrow's proposal automatically.",
  },
] as const;

const SUBTITLE: Record<string, string> = {
  planning: "Review the proposed shortlist below, make it yours, then commit today's plan.",
  committed: "Plan committed — work the list. Come back this evening for the recap.",
  recapped: "Day closed. Tomorrow's proposal will pick up anything that rolled over.",
};

/**
 * The Daily Digest "Today" ritual (spec §10.3): Claude proposes a deadline-first
 * shortlist; I reorder / remove / add a goal, then commit it as today's plan.
 * Gamification (ring, streak) + the evening recap land in 2.9.
 */
export function Today({ onOpen, onAddTask }: { onOpen: (id: string) => void; onAddTask?: () => void }) {
  const qc = useQueryClient();
  const fmts = useDateFormats();
  const digest = useQuery({ queryKey: ["digest", "today"], queryFn: () => getDigest() });

  const [picks, setPicks] = useState<DigestPick[]>([]);
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const loadedKey = useRef<string | null>(null);

  // Seed local edits from the server proposal/committed plan — re-seed when the
  // date rolls over or the status flips (planning → committed after a commit).
  useEffect(() => {
    const d = digest.data;
    if (!d) return;
    const key = `${d.date}:${d.status}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    setPicks(d.picks);
    setGoal(d.goal ?? "");
    setConstraints(d.constraints ?? "");
  }, [digest.data]);

  const commit = useMutation({
    mutationFn: () =>
      commitDigest({ picks: picks.map((p) => p.taskId), goal: goal || null, constraints: constraints || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["digest"] }),
  });

  const recap = useMutation({
    mutationFn: () => recapDigest(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["digest"] }),
  });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= picks.length) return;
    const next = picks.slice();
    [next[i], next[j]] = [next[j] as DigestPick, next[i] as DigestPick];
    setPicks(next);
  };
  const remove = (i: number) => setPicks(picks.filter((_, k) => k !== i));

  const status = digest.data?.status;
  const committed = status === "committed" || status === "recapped";
  const recapped = status === "recapped";
  const progress = digest.data?.progress;
  const streak = digest.data?.streak ?? 0;

  // Candidates for "Add to plan": open tasks not already picked, most urgent first.
  const tasks = useQuery({ queryKey: ["tasks", "urgency"], queryFn: () => getTasks({ sort: "urgency" }) });
  const pickedIds = new Set(picks.map((p) => p.taskId));
  const addable = (tasks.data ?? [])
    .filter((t) => !pickedIds.has(t.id) && t.status !== "done" && t.status !== "cancelled")
    .slice(0, 6);
  const addToPlan = (t: Task) =>
    setPicks((prev) => [
      ...prev,
      {
        taskId: t.id,
        title: t.title,
        status: t.status,
        rationale: "Added by you",
        order: prev.length,
        urgencyTier: "none",
      },
    ]);

  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-1 size-5 text-primary" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
            {digest.data ? (
              <span className="text-sm text-muted-foreground">{formatDayKey(digest.data.date, fmts)}</span>
            ) : null}
            {recapped ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-2.5 py-1 text-xs font-medium text-indigo-300">
                <Moon className="size-3.5" /> Recapped
              </span>
            ) : committed ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-400">
                <CalendarCheck className="size-3.5" /> Committed
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                Planning
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {SUBTITLE[status ?? "planning"]}
          </p>
        </div>

        {committed && progress ? (
          <div className="ml-auto flex items-center gap-4 text-primary">
            <span
              className={cn(
                "inline-flex items-center gap-1 text-sm font-medium",
                streak > 0 ? "text-amber-400" : "text-muted-foreground",
              )}
              title={
                streak > 0
                  ? `${streak}-day streak of finishing every planned task`
                  : "Streak: finish every task in a committed plan to start one"
              }
            >
              <Flame className="size-4" /> {streak}
            </span>
            <ProgressRing done={progress.done} total={progress.total} />
          </div>
        ) : null}
      </div>

      {/* The ritual, made visible: where you are and what each step does. */}
      <ol className="mt-5 grid gap-2 sm:grid-cols-3">
        {RITUAL_STEPS.map((step) => {
          const active = (status ?? "planning") === step.id;
          const doneStep =
            (step.id === "planning" && committed) || (step.id === "committed" && recapped);
          return (
            <li
              key={step.id}
              className={cn(
                "rounded-lg border p-3",
                active ? "border-primary/50 bg-primary/5" : "border-border bg-card/40",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2 text-xs font-medium",
                  active ? "text-primary" : doneStep ? "text-emerald-400" : "text-muted-foreground",
                )}
              >
                {doneStep ? <Check className="size-3.5" /> : <step.icon className="size-3.5" />}
                {step.title}
                {active ? (
                  <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px]">
                    you are here
                  </span>
                ) : null}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{step.text}</p>
            </li>
          );
        })}
      </ol>

      {recapped && digest.data?.recap ? (
        <div className="mt-4 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-indigo-300">
            <Moon className="size-4" /> Evening recap
          </div>
          <p className="mt-1.5 text-sm text-foreground/90">{digest.data.recap.note}</p>
          {digest.data.recap.shipped.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Shipped: {digest.data.recap.shipped.join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {digest.isError ? (
        <p className="mt-4 text-sm text-red-400">Couldn’t load today’s digest.</p>
      ) : null}

      <SweepPanel onOpen={onOpen} />

      <label className="mt-5 text-xs font-medium text-muted-foreground" htmlFor="digest-goal">
        What matters most today?
      </label>
      <input
        id="digest-goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="e.g. Ship the deadline-critical fix"
        className="mt-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />

      <label className="mt-3 text-xs font-medium text-muted-foreground" htmlFor="digest-constraints">
        Constraints (meetings, energy…)
      </label>
      <input
        id="digest-constraints"
        value={constraints}
        onChange={(e) => setConstraints(e.target.value)}
        placeholder="e.g. 2 meetings this afternoon"
        className="mt-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />

      <h2 className="mt-6 text-sm font-medium">
        Plan <span className="text-muted-foreground">({picks.length})</span>
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Proposed automatically from your open tasks — deadlines first, then priority. Edits here
        stay local until you commit.
      </p>
      <ol className="mt-2 flex flex-col gap-2">
        {picks.length === 0 ? (
          <li className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing planned yet. Capture a few tasks and the most urgent ones appear here as a
            proposal.
            {onAddTask ? (
              <LabeledIconButton icon={<Plus />} label="Add a task" size="sm" onClick={onAddTask} />
            ) : null}
          </li>
        ) : null}
        {picks.map((p, i) => {
          const badge = TIER_BADGE[p.urgencyTier];
          return (
            <li
              key={p.taskId}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
            >
              <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
              <button
                type="button"
                onClick={() => onOpen(p.taskId)}
                className="flex-1 text-left hover:underline"
              >
                <div className="text-sm font-medium">{p.title}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  {badge ? (
                    <span className={`rounded px-1.5 py-0.5 font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                  ) : null}
                  <span>{p.rationale}</span>
                </div>
              </button>
              <button
                type="button"
                aria-label="Move up"
                title="Move up"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                <ArrowUp className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Move down"
                title="Move down"
                onClick={() => move(i, 1)}
                disabled={i === picks.length - 1}
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                <ArrowDown className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Remove from plan"
                title="Remove from plan"
                onClick={() => remove(i)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400"
              >
                <X className="size-4" />
              </button>
            </li>
          );
        })}
      </ol>

      {!recapped && addable.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            More open tasks ({addable.length}) — add to today’s plan
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {addable.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => onOpen(t.id)}
                  className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                >
                  {t.title}
                </button>
                <LabeledIconButton
                  icon={<Plus />}
                  label="Add to plan"
                  variant="ghost"
                  size="sm"
                  onClick={() => addToPlan(t)}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mt-5 flex items-center gap-3">
        <LabeledIconButton
          icon={committed ? <Check /> : <CalendarCheck />}
          label={committed ? "Update plan" : "Commit today’s plan"}
          onClick={() => commit.mutate()}
          disabled={commit.isPending}
        />
        {committed ? (
          <LabeledIconButton
            icon={<Moon />}
            label={recapped ? "Refresh recap" : "Evening recap"}
            variant="ghost"
            onClick={() => recap.mutate()}
            disabled={recap.isPending}
          />
        ) : null}
        {commit.isSuccess && !commit.isPending ? (
          <span className="text-xs text-green-400">Saved.</span>
        ) : null}
        {commit.isError || recap.isError ? (
          <span className="text-xs text-red-400">Couldn’t save.</span>
        ) : null}
      </div>
    </div>
  );
}
