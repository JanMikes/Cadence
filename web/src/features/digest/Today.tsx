import type { DigestPick } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CalendarCheck, Check, Flame, Moon, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { commitDigest, getDigest, recapDigest } from "../../lib/api";
import { ProgressRing } from "./ProgressRing";
import { SweepPanel } from "./SweepPanel";

const TIER_BADGE: Record<string, { label: string; className: string }> = {
  overdue: { label: "Overdue", className: "bg-red-500/15 text-red-400" },
  due_soon: { label: "Due soon", className: "bg-amber-500/15 text-amber-400" },
};

/**
 * The Daily Digest "Today" ritual (spec §10.3): Claude proposes a deadline-first
 * shortlist; I reorder / remove / add a goal, then commit it as today's plan.
 * Gamification (ring, streak) + the evening recap land in 2.9.
 */
export function Today({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
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

  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-1 size-5 text-primary" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
            {digest.data ? (
              <span className="text-sm text-muted-foreground">{digest.data.date}</span>
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
            A deadline-first shortlist. Reorder, trim to what matters, then commit your plan.
          </p>
        </div>

        {committed && progress ? (
          <div className="ml-auto flex items-center gap-4 text-primary">
            {streak > 0 ? (
              <span
                className="inline-flex items-center gap-1 text-sm font-medium text-amber-400"
                title={`${streak}-day streak of meeting your plan`}
              >
                <Flame className="size-4" /> {streak}
              </span>
            ) : null}
            <ProgressRing done={progress.done} total={progress.total} />
          </div>
        ) : null}
      </div>

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
      <ol className="mt-2 flex flex-col gap-2">
        {picks.length === 0 ? (
          <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing planned. Capture some tasks and they’ll surface here, deadline-first.
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
