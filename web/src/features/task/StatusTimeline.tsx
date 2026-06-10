import type { TaskEvent } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { getTimeline } from "../../lib/api";
import { formatDateTime, useDateFormats } from "../../lib/datetime";
import { statusLabel } from "../../lib/status";

interface StatusChangePayload {
  from: string | null;
  to: string;
}

function isStatusChange(e: TaskEvent): e is TaskEvent & { payload: StatusChangePayload } {
  return (
    e.type === "status_change" &&
    typeof e.payload === "object" &&
    e.payload !== null &&
    "to" in (e.payload as Record<string, unknown>)
  );
}

/**
 * The task's status history (spec §6) — a compact, oldest-first timeline of
 * lifecycle transitions, refetched whenever the task is invalidated.
 */
export function StatusTimeline({ taskId }: { taskId: string }) {
  const fmts = useDateFormats();
  const timeline = useQuery({
    queryKey: ["task", taskId, "timeline"],
    queryFn: () => getTimeline(taskId),
  });

  const changes = (timeline.data ?? []).filter(isStatusChange);
  if (changes.length === 0) return null;

  return (
    <section className="mt-7 border-t border-border pt-5">
      <h3 className="text-sm font-medium">History</h3>
      <ol className="mt-3 flex flex-col gap-1.5">
        {changes.map((e) => (
          <li key={e.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {formatDateTime(e.createdAt, fmts)}
            </span>
            {e.payload.from ? (
              <span className="flex items-center gap-1.5">
                <span>{statusLabel(e.payload.from)}</span>
                <ArrowRight className="size-3 opacity-60" />
                <span className="text-foreground">{statusLabel(e.payload.to)}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="opacity-60">captured</span>
                <ArrowRight className="size-3 opacity-60" />
                <span className="text-foreground">{statusLabel(e.payload.to)}</span>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
