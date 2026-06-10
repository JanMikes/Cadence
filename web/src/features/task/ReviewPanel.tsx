import { deliveryModeLabel } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitMerge, RotateCcw } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getDelivery, getDiff, getVerify, mergeReview, requestChanges } from "../../lib/api";

/** A single diff line, colored by +/-/@ prefix. */
function DiffLine({ line }: { line: string }) {
  const cls = line.startsWith("+")
    ? "text-green-400"
    : line.startsWith("-")
      ? "text-red-400"
      : line.startsWith("@@")
        ? "text-cyan-400"
        : "text-muted-foreground";
  return <div className={cls}>{line || " "}</div>;
}

/**
 * The Review screen (spec §7.7/§10): delivery summary + verify results + the diff,
 * with the mode-appropriate accept action (→ done) / Request changes (→ implementing).
 * Mode-aware: "merge a branch" and "accept changes already in my checkout" are
 * different decisions and must read differently. The evidence line says what was
 * actually delivered (and that it's attributable to this task's run — never guesswork).
 */
export function ReviewPanel({
  taskId,
  onChanged,
  onMerged,
  onRequestedChanges,
}: {
  taskId: string;
  onChanged: () => void;
  /** Fired after a successful merge (on top of onChanged) — lets the host close
   *  the modal / celebrate. */
  onMerged?: () => void;
  /** Fired after changes were requested (on top of onChanged) — the task went back
   *  to In progress and the implementer is re-running with the note. */
  onRequestedChanges?: () => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");

  const delivery = useQuery({ queryKey: ["task", taskId, "delivery"], queryFn: () => getDelivery(taskId) });
  const verify = useQuery({ queryKey: ["task", taskId, "verify"], queryFn: () => getVerify(taskId) });
  const diff = useQuery({ queryKey: ["task", taskId, "diff"], queryFn: () => getDiff(taskId) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
    onChanged();
  };
  const merge = useMutation({
    mutationFn: () => mergeReview(taskId),
    onSuccess: () => {
      invalidate();
      onMerged?.();
    },
  });
  const reqChanges = useMutation({
    mutationFn: () => requestChanges(taskId, note.trim()),
    onSuccess: () => {
      invalidate();
      onRequestedChanges?.();
    },
  });

  const diffLines = (diff.data?.diff ?? "").split("\n");
  const hasDiff = (diff.data?.diff ?? "").trim().length > 0;
  const mode = diff.data?.mode ?? "";
  const inPlace = mode === "apply_in_place";
  const evidence = diff.data?.evidence;

  return (
    <section className="mt-5 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <GitMerge className="size-4 text-primary" /> Review
        {mode ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
            {deliveryModeLabel(mode)}
          </span>
        ) : null}
        {diff.data?.branch ? (
          <span className="font-mono text-[11px] text-muted-foreground">{diff.data.branch}</span>
        ) : null}
      </h3>

      {/* What was actually delivered — the attributable verdict, not tree guesswork. */}
      {evidence ? (
        <p
          className={`mt-2 text-xs ${
            evidence.attributable && evidence.hasWork
              ? "text-emerald-400"
              : evidence.attributable
                ? "text-amber-400"
                : "text-muted-foreground"
          }`}
        >
          {evidence.attributable
            ? evidence.hasWork
              ? `Delivered by this task’s run: ${evidence.detail}.`
              : `Nothing attributable was delivered — ${evidence.detail}.`
            : evidence.detail}
        </p>
      ) : null}

      {delivery.data?.summary ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{delivery.data.summary}</p>
      ) : null}
      {delivery.data?.prUrl ? (
        <a href={delivery.data.prUrl} className="mt-1 inline-block text-xs text-primary underline">
          View PR
        </a>
      ) : null}

      {verify.data ? (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <span
            className={`rounded px-1.5 py-0.5 font-medium ${verify.data.passed ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}
          >
            {verify.data.passed ? "Verify passed" : "Verify failed"}
          </span>
          {verify.data.checks.map((c) => (
            <span key={c.name} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {c.passed ? "✅" : "❌"} {c.name}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-3 max-h-72 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
        {hasDiff ? (
          diffLines.map((l, i) => <DiffLine key={i} line={l} />)
        ) : (
          <span className="text-muted-foreground">No diff to show.</span>
        )}
      </div>

      {inPlace ? (
        <p className="mt-2 text-xs text-muted-foreground">
          These changes are already in your working copy (no branch, nothing to merge) — accepting
          marks the task done.
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <LabeledIconButton
          icon={<Check />}
          label={inPlace ? "Accept → Done" : "Merge → Done"}
          onClick={() => merge.mutate()}
          disabled={merge.isPending}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What to change…"
          aria-label="Request changes note"
          className="flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <LabeledIconButton
          icon={<RotateCcw />}
          label="Request changes"
          variant="ghost"
          onClick={() => reqChanges.mutate()}
          disabled={reqChanges.isPending}
        />
      </div>
      {merge.isError ? (
        <p className="mt-2 text-xs text-red-400">
          {inPlace ? "Couldn’t accept" : "Couldn’t merge"}: {(merge.error as Error).message}
        </p>
      ) : null}
    </section>
  );
}
