import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ListChecks } from "lucide-react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { approvePlan, getPlan } from "../../lib/api";

/**
 * The Planner's output (§7.4): an ordered, approvable implementation plan shown
 * once a task is executing. The Implementer (3.4) runs only after approval.
 */
export function PlanView({ taskId, onResolved }: { taskId: string; onResolved?: () => void }) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["task", taskId, "plan"], queryFn: () => getPlan(taskId) });

  const approve = useMutation({
    mutationFn: () => approvePlan(taskId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["task", taskId, "plan"] });
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      onResolved?.();
    },
  });

  const steps = plan.data?.steps ?? [];
  if (steps.length === 0) {
    // Planner may still be running right after PLAY.
    return plan.data ? (
      <section className="mt-5 rounded-lg border border-border bg-card/40 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="size-4" /> Plan
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Planning… the Planner is drafting steps.</p>
      </section>
    ) : null;
  }

  const approved = plan.data?.approved ?? false;

  return (
    <section className="mt-5 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="size-4" /> Plan
          {approved ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
              <Check className="size-3" /> Approved
            </span>
          ) : null}
        </div>
        {!approved ? (
          <LabeledIconButton
            icon={<Check />}
            label="Approve plan"
            size="sm"
            onClick={() => approve.mutate()}
            disabled={approve.isPending}
          />
        ) : null}
      </div>

      <ol className="mt-3 flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={`${i}-${s.title}`} className="flex gap-2 text-sm">
            <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
            <div>
              <div className="flex items-center gap-1.5 font-medium">
                {s.risky ? <AlertTriangle className="size-3.5 text-amber-400" /> : null}
                {s.title}
              </div>
              {s.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p> : null}
              {s.files?.length ? (
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/80">
                  {s.files.join(", ")}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {plan.data?.notes ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">{plan.data.notes}</p>
      ) : null}
    </section>
  );
}
