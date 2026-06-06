import type { Suggestion, SuggestionAction } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Sparkles, Undo2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getSuggestions, resolveSuggestion } from "../../lib/api";
import { cn } from "../../lib/utils";

const STATUS_BADGE: Record<string, string> = {
  suggested: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  confirmed: "border-green-500/40 bg-green-500/10 text-green-400",
  edited: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  overridden: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  dismissed: "border-border bg-muted text-muted-foreground",
};

function display(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * The reusable "propose, don't impose" control (§10.2): shows a suggested field
 * value + rationale + confidence, with Accept / Edit / Override / Dismiss and
 * per-field provenance (suggested → confirmed | edited | overridden | dismissed).
 */
export function SuggestionControl({
  suggestion,
  onResolved,
}: {
  suggestion: Suggestion;
  onResolved: () => void;
}) {
  const [mode, setMode] = useState<"edit" | "override" | null>(null);
  const [draft, setDraft] = useState(display(suggestion.value));

  const resolve = useMutation({
    mutationFn: (args: { action: SuggestionAction; value?: unknown }) =>
      resolveSuggestion(suggestion.id, args.action, args.value),
    onSuccess: () => {
      setMode(null);
      onResolved();
    },
  });

  const open = suggestion.status === "suggested";

  const submitDraft = (e: FormEvent) => {
    e.preventDefault();
    if (mode) resolve.mutate({ action: mode, value: draft });
  };

  return (
    <div className="rounded-md border border-border bg-card/50 p-3">
      <div className="flex items-center gap-2 text-xs">
        <Sparkles className="size-3.5 text-primary" />
        <span className="font-medium">{suggestion.field}</span>
        <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px]", STATUS_BADGE[suggestion.status])}>
          {suggestion.status}
        </span>
        {suggestion.confidence != null ? (
          <span className="text-muted-foreground">{Math.round(suggestion.confidence * 100)}%</span>
        ) : null}
        {suggestion.source ? <span className="text-muted-foreground">· {suggestion.source}</span> : null}
      </div>

      {mode ? (
        <form onSubmit={submitDraft} className="mt-2 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`${mode} value`}
            className="flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <LabeledIconButton icon={<Check />} label="Save" type="submit" size="sm" disabled={resolve.isPending} />
          <LabeledIconButton icon={<X />} label="Cancel" variant="ghost" size="sm" onClick={() => setMode(null)} />
        </form>
      ) : (
        <div className="mt-1 text-sm">{display(suggestion.value)}</div>
      )}

      {suggestion.rationale ? (
        <div className="mt-1 text-xs text-muted-foreground">{suggestion.rationale}</div>
      ) : null}

      {open && !mode ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <LabeledIconButton
            icon={<Check />}
            label="Accept"
            size="sm"
            onClick={() => resolve.mutate({ action: "accept" })}
            disabled={resolve.isPending}
          />
          <LabeledIconButton
            icon={<Pencil />}
            label="Edit"
            variant="secondary"
            size="sm"
            onClick={() => {
              setDraft(display(suggestion.value));
              setMode("edit");
            }}
          />
          <LabeledIconButton
            icon={<Undo2 />}
            label="Override"
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft("");
              setMode("override");
            }}
          />
          <LabeledIconButton
            icon={<X />}
            label="Dismiss"
            variant="ghost"
            size="sm"
            onClick={() => resolve.mutate({ action: "dismiss" })}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Renders all suggestions for an entity (nothing if there are none). */
export function SuggestionList({ entityType, entityId }: { entityType: string; entityId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["suggestions", entityType, entityId],
    queryFn: () => getSuggestions(entityType, entityId),
  });

  if (!q.data || q.data.length === 0) return null;
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["suggestions", entityType, entityId] });

  return (
    <section className="mt-5 flex flex-col gap-2 border-t border-border pt-5">
      <h3 className="text-sm font-medium">Suggestions</h3>
      {q.data.map((s) => (
        <SuggestionControl key={s.id} suggestion={s} onResolved={invalidate} />
      ))}
    </section>
  );
}
