import { useQuery } from "@tanstack/react-query";
import { getTaskRuns } from "../../lib/api";
import { formatDateTime, useDateFormats } from "../../lib/datetime";
import { roleLabel } from "../../lib/status";

/**
 * "What happened" — the durable per-stage agent outputs (runs.md): every pipeline
 * run with when, which agent, outcome, cost, and its final words. Collapsed by
 * default (the newest entry open) so the story is scannable; the Sessions list
 * above stays the live/transcript view of the same runs.
 */
export function RunReports({ taskId }: { taskId: string }) {
  const fmts = useDateFormats();
  const runs = useQuery({ queryKey: ["task", taskId, "runs"], queryFn: () => getTaskRuns(taskId) });
  const entries = runs.data?.entries ?? [];
  if (entries.length === 0) return null;

  // Newest first — "what just happened" is the question being asked.
  const ordered = [...entries].reverse();

  return (
    <section className="mt-7 border-t border-border pt-5">
      <h3 className="text-sm font-medium">What happened — agent runs</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Each pipeline stage’s final report, kept on the task (also on disk as runs.md).
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {ordered.map((r, i) => (
          <li key={`${r.sessionId ?? r.role}-${r.at}`}>
            <details
              open={i === 0}
              className="rounded-md border border-border bg-card/50 px-3 py-2 text-xs"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-medium">{roleLabel(r.role)}</span>
                  <span
                    className={
                      r.status === "done"
                        ? "rounded bg-green-500/15 px-1 py-0.5 text-[10px] text-green-400"
                        : r.status === "needs_input"
                          ? "rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-400"
                          : "rounded bg-red-500/15 px-1 py-0.5 text-[10px] text-red-400"
                    }
                  >
                    {r.status === "done" ? "finished" : r.status === "needs_input" ? "needs your input" : "failed"}
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {formatDateTime(r.at, fmts)}
                  {r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ""}
                </span>
              </summary>
              <div className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap border-t border-border pt-2 text-muted-foreground">
                {r.output || "(no output)"}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
