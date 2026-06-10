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
  Pencil,
  Plus,
  Sparkles,
  Target,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { toast } from "../../components/Toaster";
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
  planning:
    "Two minutes now sets up the whole day: review the shortlist, add what's missing, commit.",
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
  // After commit the focus inputs collapse into a banner; this re-opens them.
  const [editFocus, setEditFocus] = useState(false);
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

  const status = digest.data?.status;
  const committed = status === "committed" || status === "recapped";
  const recapped = status === "recapped";
  const progress = digest.data?.progress;
  const streak = digest.data?.streak ?? 0;

  const commit = useMutation({
    mutationFn: () =>
      commitDigest({ picks: picks.map((p) => p.taskId), goal: goal || null, constraints: constraints || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["digest"] });
      setEditFocus(false);
      // `committed` still holds the pre-mutation status here: first commit vs update.
      toast(
        committed
          ? "Plan updated."
          : `Plan committed — ${picks.length} task${picks.length === 1 ? "" : "s"} for today. Go get it 🔥`,
      );
    },
  });

  const recap = useMutation({
    mutationFn: () => recapDigest(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["digest"] });
      toast("Recap saved — day closed 🌙");
    },
  });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= picks.length) return;
    const next = picks.slice();
    [next[i], next[j]] = [next[j] as DigestPick, next[i] as DigestPick];
    setPicks(next);
  };
  const remove = (i: number) => setPicks(picks.filter((_, k) => k !== i));

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
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-400">
                <TriangleAlert className="size-3.5" /> Planning — not committed yet
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

      {/* Focus is optional by design: the plan alone is a valid commit. While planning the
          inputs are grouped in one light card; once committed they collapse into a banner
          so the day's intent stays visible without inviting constant re-editing. */}
      {!committed || editFocus ? (
        <div className="mt-5 rounded-lg border border-border bg-card/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Target className="size-4 text-primary" /> Set your focus
            <span className="text-xs font-normal text-muted-foreground">
              optional — the plan alone is enough to commit
            </span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="digest-goal">
                What matters most today?
              </label>
              <input
                id="digest-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Ship the deadline-critical fix"
                className="mt-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="flex flex-col">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="digest-constraints"
              >
                Constraints (meetings, energy…)
              </label>
              <input
                id="digest-constraints"
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                placeholder="e.g. 2 meetings this afternoon"
                className="mt-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            One honest line beats a perfect plan — skip it freely on busy mornings.
          </p>
          {committed ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Changes here are saved when you press “Update plan” below.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-primary">
            <Target className="size-4" /> Focus
          </span>
          {goal ? (
            <span>{goal}</span>
          ) : (
            <span className="text-muted-foreground">No focus set for today.</span>
          )}
          {constraints ? <span className="text-muted-foreground">· {constraints}</span> : null}
          {!recapped ? (
            <span className="ml-auto">
              <LabeledIconButton
                icon={<Pencil />}
                label={goal || constraints ? "Edit focus" : "Add a focus"}
                variant="ghost"
                size="sm"
                onClick={() => setEditFocus(true)}
              />
            </span>
          ) : null}
        </div>
      )}

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
        // Default-open while planning so nothing urgent hides behind a fold during
        // the "did I miss anything?" pass; folded once the plan is committed.
        <details className="mt-3" open={!committed || undefined}>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            More open tasks ({addable.length}) — add anything that belongs in today
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

      {!committed ? (
        /* The capture check: one deliberate beat between "shortlist looks fine" and
           commit — is everything that today actually demands on the list yet? */
        <div className="mt-6 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarCheck className="size-4 text-primary" /> Ready to commit?
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Last look: is everything today demands on this list — meetings to prep, reviews you
            promised, the small thing you keep postponing? Capture it now and the plan is honest.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <LabeledIconButton
              icon={<CalendarCheck />}
              label="Commit today’s plan"
              onClick={() => commit.mutate()}
              disabled={commit.isPending || picks.length === 0}
            />
            {onAddTask ? (
              <LabeledIconButton
                icon={<Plus />}
                label="Something’s missing — add a task"
                variant="ghost"
                onClick={onAddTask}
              />
            ) : null}
          </div>
          {picks.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Add at least one task to commit — an empty plan isn’t a plan yet.
            </p>
          ) : null}
          {commit.isError ? (
            <p className="mt-2 text-xs text-red-400">Couldn’t save.</p>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 flex items-center gap-3">
          <LabeledIconButton
            icon={<Check />}
            label="Update plan"
            onClick={() => commit.mutate()}
            disabled={commit.isPending || picks.length === 0}
          />
          <LabeledIconButton
            icon={<Moon />}
            label={recapped ? "Refresh recap" : "Evening recap"}
            variant="ghost"
            onClick={() => recap.mutate()}
            disabled={recap.isPending}
          />
          {commit.isError || recap.isError ? (
            <span className="text-xs text-red-400">Couldn’t save.</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
