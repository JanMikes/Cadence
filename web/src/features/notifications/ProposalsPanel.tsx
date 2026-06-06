import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Sparkles } from "lucide-react";
import { getProposals, reflectMemory } from "../../lib/api";

/**
 * Proactive proposals (spec §8.1/§10.2): occasional, propose-don't-impose nudges
 * from the sweep + self-monitor. Shown atop Notifications; the "reflect" proposal
 * is actionable. (They also arrive as live notifications when the sweep runs.)
 */
export function ProposalsPanel({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const qc = useQueryClient();
  const proposals = useQuery({ queryKey: ["proposals"], queryFn: getProposals });
  const reflect = useMutation({
    mutationFn: reflectMemory,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["proposals"] });
      void qc.invalidateQueries({ queryKey: ["memory"] });
    },
  });

  const items = proposals.data ?? [];
  if (items.length === 0) return null;

  return (
    <section className="mt-6 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-primary">
        <Lightbulb className="size-4" /> Proposals
      </h2>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{p.title}</span>
              <span className="block text-xs text-muted-foreground">{p.message}</span>
            </span>
            {p.kind === "reflect" ? (
              <button
                type="button"
                onClick={() => reflect.mutate()}
                disabled={reflect.isPending}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                <Sparkles className="size-3.5" /> Reflect
              </button>
            ) : onNavigate ? (
              <button
                type="button"
                onClick={() => onNavigate(p.kind === "deadline" ? "calendar" : "board")}
                className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Review
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
