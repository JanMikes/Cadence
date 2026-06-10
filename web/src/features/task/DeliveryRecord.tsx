import type { TaskGitContext } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { GitMerge } from "lucide-react";
import { getDelivery } from "../../lib/api";
import { gitStateLabel, gitStateTone } from "../../lib/git";
import { cn } from "../../lib/utils";

/**
 * The read-only delivery record for a DONE task — closes the "merged and gone" gap:
 * ReviewPanel disappears after merge, and without this a done task showed nothing
 * about its git outcome. Same honest-closed-surface treatment as ReviewWorkspace:
 * a record of what happened, no controls. Tone follows the git state — green when
 * the work landed on base, amber when a done task's branch never actually merged.
 */
export function DeliveryRecord({
  taskId,
  gitContext,
}: {
  taskId: string;
  gitContext: TaskGitContext | null;
}) {
  const delivery = useQuery({
    queryKey: ["task", taskId, "delivery"],
    queryFn: () => getDelivery(taskId),
  });
  const d = delivery.data ?? null;
  if (!d && !gitContext) return null; // nothing was delivered — render nothing, not a husk

  const tone = gitContext ? gitStateTone(gitContext) : "ok";
  const warn = tone === "warn";
  return (
    <section
      className={cn(
        "mt-5 rounded-lg border p-4",
        warn ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 text-sm font-medium",
          warn ? "text-amber-300" : "text-emerald-300",
        )}
      >
        <GitMerge className="size-4" aria-hidden />
        Delivered
        {(gitContext?.branch ?? d?.branch) ? (
          <span className="font-mono text-[11px] font-normal text-muted-foreground">
            {gitContext?.branch ?? d?.branch}
          </span>
        ) : null}
      </div>
      {gitContext ? (
        <p className={cn("mt-1 text-xs", warn ? "text-amber-400" : "text-muted-foreground")}>
          {gitStateLabel(gitContext)}
        </p>
      ) : null}
      {d?.summary ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{d.summary}</p>
      ) : null}
      {d?.prUrl ? (
        <a
          href={d.prUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs text-primary hover:underline"
        >
          Open PR/MR ↗
        </a>
      ) : null}
    </section>
  );
}
