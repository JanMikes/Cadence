import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ListChecks, Play, RotateCcw } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { toast } from "../../components/Toaster";
import { useActivity } from "../../lib/activity";
import { approvePlan, getPlan, revisePlan } from "../../lib/api";

/**
 * The Planner's output (§7.4): an ordered, approvable implementation plan shown
 * once a task is executing. The Implementer (3.4) runs only after approval.
 */
export function PlanView({
  taskId,
  status,
  onResolved,
}: {
  taskId: string;
  /** The task's current status — gates the "Planning…" placeholder to the window
   *  where the Planner can actually be running. */
  status: string;
  onResolved?: () => void;
}) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["task", taskId, "plan"], queryFn: () => getPlan(taskId) });
  const [feedback, setFeedback] = useState("");

  const approve = useMutation({
    mutationFn: () => approvePlan(taskId),
    onSuccess: () => {
      // plan.data still holds the pre-click value here (invalidation is async), so
      // it tells us whether this was a first approval or an interrupted-run retry.
      toast(
        plan.data?.approved
          ? "Implementation restarted — the run is starting now."
          : "Plan approved — implementation starting.",
      );
      void qc.invalidateQueries({ queryKey: ["task", taskId, "plan"] });
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      onResolved?.();
    },
  });

  const revise = useMutation({
    mutationFn: () => revisePlan(taskId, feedback.trim()),
    onSuccess: () => {
      toast("Plan sent back — the Planner is re-drafting with your feedback.");
      setFeedback("");
      void qc.invalidateQueries({ queryKey: ["task", taskId, "plan"] });
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
      void qc.invalidateQueries({ queryKey: ["task", taskId, "context"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      onResolved?.();
    },
  });

  // "Planning…" only when a Planner run is verifiably alive (display-logic rule:
  // status alone can lie — a task stays "implementing" after a planner dies).
  const activeStage = useActivity(taskId);

  const steps = plan.data?.steps ?? [];
  if (steps.length === 0) {
    // The Planner only runs in the window between PLAY and Plan review (status
    // "implementing", §7.4). Anywhere else an empty plan just means none was
    // written (e.g. merged without one) — show nothing, not a stale "Planning…".
    if (!plan.data || status !== "implementing") return null;
    if (activeStage === "planner" || activeStage === "queued") {
      return (
        <section className="mt-5 rounded-lg border border-border bg-card/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ListChecks className="size-4" /> Plan
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Planning… the Planner is drafting steps.</p>
        </section>
      );
    }
    // No plan AND no live planner: be honest about the interruption instead of
    // showing an eternal "Planning…" (no silent dead ends, §10).
    return (
      <section className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
          <AlertTriangle className="size-4" /> Plan
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          No plan yet and the Planner isn’t running — it was likely interrupted. Check “What
          happened” below; to retry, move the task back to Ready and press PLAY again.
        </p>
      </section>
    );
  }

  const approved = plan.data?.approved ?? false;
  // Plan review means execution is NOT running — an already-approved plan here is a
  // run that never started (e.g. queued behind the project lock when the app
  // restarted) and was parked back by recovery. The server's approve endpoint is
  // exactly the retry path, so the action must stay visible (no silent dead ends) —
  // gating it on `approved` alone left exactly that dead end.
  const interruptedApproved = approved && status === "plan_review";

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
        {!approved || interruptedApproved ? (
          <LabeledIconButton
            icon={approved ? <Play /> : <Check />}
            label={approve.isPending ? "Starting…" : approved ? "Run plan" : "Approve plan"}
            size="sm"
            onClick={() => approve.mutate()}
            disabled={approve.isPending}
          />
        ) : null}
      </div>

      {interruptedApproved ? (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
          This plan was approved, but its run was interrupted before it could start (for example
          by an app restart while it waited for the project dir). Press “Run plan” to start
          implementation again.
        </p>
      ) : null}

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

      {status === "plan_review" ? (
        // Plan review's second exit: don't approve — say what to change and the
        // Planner re-drafts. Approval was the ONLY action before, so unwanted
        // plans were a dead end (delete the task or run work you didn't want).
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            Not what you wanted? Describe the change and the Planner re-drafts the plan with your
            feedback (it also sees anything you’ve added to the context channel).
          </p>
          <div className="mt-2 flex items-end gap-2">
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. skip step 2 — the API already exposes this; keep it client-side"
              rows={2}
              className="min-h-0 flex-1 resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <LabeledIconButton
              icon={<RotateCcw />}
              label={revise.isPending ? "Re-planning…" : "Revise plan"}
              size="sm"
              onClick={() => revise.mutate()}
              disabled={revise.isPending}
            />
          </div>
          {revise.isError ? (
            <p className="mt-1 text-xs text-red-400">
              Couldn’t start the revision — is the task still in Plan review?
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
