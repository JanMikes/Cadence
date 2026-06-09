import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldQuestion, X } from "lucide-react";
import { type FlowControls, FlowStrip } from "../../components/FlowStrip";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getApprovals, resolveApproval } from "../../lib/api";

/**
 * A parked Manual-mode tool action, as a centered modal step in the flow. Approve/Deny
 * resolve the live `canUseTool` gate; resolving advances the flow.
 */
export function ToolApprovalModal({
  approvalId,
  flow,
  onResolved,
  onClose,
}: {
  approvalId: string;
  flow?: FlowControls;
  onResolved: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: getApprovals, refetchInterval: 2000 });
  const req = approvals.data?.find((a) => a.id === approvalId);

  const resolve = useMutation({
    mutationFn: (allow: boolean) => resolveApproval(approvalId, allow),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      onResolved();
    },
  });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {flow ? <FlowStrip flow={flow} /> : null}
        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-red-300">
              <ShieldQuestion className="size-5" /> Tool action awaiting approval
            </h2>
            <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            A live agent is blocked (Manual mode) until you decide.
          </p>
          {req ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{req.toolName}</span>
              <code className="flex-1 truncate text-xs text-muted-foreground">
                {typeof req.input === "string" ? req.input : JSON.stringify(req.input)}
              </code>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">This request was already resolved.</p>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => resolve.mutate(true)}
              disabled={resolve.isPending || !req}
              className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-60"
            >
              <Check className="size-4" /> Approve
            </button>
            <button
              type="button"
              onClick={() => resolve.mutate(false)}
              disabled={resolve.isPending || !req}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:border-red-500/50 hover:text-red-400 disabled:opacity-60"
            >
              <X className="size-4" /> Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
