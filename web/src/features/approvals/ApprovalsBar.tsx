import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldQuestion, X } from "lucide-react";
import { getApprovals, resolveApproval } from "../../lib/api";

/**
 * Manual-mode approvals (spec §9.1): when an agent's tool action is parked, this
 * fixed banner surfaces it with Approve / Deny — the in-app `canUseTool` gate.
 * Polls (and is also nudged by the approval:* WS events the app already listens to).
 */
export function ApprovalsBar() {
  const qc = useQueryClient();
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: getApprovals,
    refetchInterval: 2000,
  });

  const resolve = useMutation({
    mutationFn: ({ id, allow }: { id: string; allow: boolean }) => resolveApproval(id, allow),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const pending = approvals.data ?? [];
  if (pending.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[80] flex flex-col gap-2 border-t border-amber-500/40 bg-amber-500/10 p-3 backdrop-blur">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-300">
        <ShieldQuestion className="size-4" /> {pending.length} action
        {pending.length > 1 ? "s" : ""} awaiting your approval (Manual mode)
      </div>
      {pending.map((a) => {
        // A question can't be "approved" bare — answers travel with it. Point at the
        // Needs-attention flow (which renders the full answer form) and offer Skip.
        const isAsk = a.toolName === "AskUserQuestion";
        const firstQuestion = isAsk
          ? ((a.input as { questions?: Array<{ question?: string }> } | null)?.questions?.[0]?.question ?? "")
          : "";
        return (
          <div
            key={a.id}
            className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {isAsk ? "Question" : a.toolName}
            </span>
            <code className="flex-1 truncate text-xs text-muted-foreground">
              {isAsk ? firstQuestion : typeof a.input === "string" ? a.input : JSON.stringify(a.input)}
            </code>
            {isAsk ? (
              <span className="text-xs text-muted-foreground">Answer via “Needs attention”</span>
            ) : (
              <button
                type="button"
                onClick={() => resolve.mutate({ id: a.id, allow: true })}
                disabled={resolve.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-60"
              >
                <Check className="size-3.5" /> Approve
              </button>
            )}
            <button
              type="button"
              onClick={() => resolve.mutate({ id: a.id, allow: false })}
              disabled={resolve.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:border-red-500/50 hover:text-red-400 disabled:opacity-60"
            >
              <X className="size-3.5" /> {isAsk ? "Skip" : "Deny"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
