import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { getAnalytics, getSelfMonitor } from "../../lib/api";
import { statusLabel } from "../../lib/status";

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

/** Self-monitoring signals (§8.1) — the data the Reflector learns from. */
function SelfMonitorSection() {
  const m = useQuery({ queryKey: ["self-monitor"], queryFn: getSelfMonitor });
  const d = m.data;
  if (!d) return null;
  const p = d.provenance;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium">Self-monitoring</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">The signal Cadence learns from (§8.1).</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Suggestion accept rate" value={pct(d.acceptanceRate)} />
        <Stat label="Verify pass-rate" value={pct(d.verify.passRate)} />
        <Stat label="Rollovers" value={String(d.rollovers)} />
        <Stat label="Stale tasks" value={String(d.staleTasks)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {(["confirmed", "edited", "overridden", "dismissed", "suggested"] as const).map((k) => (
          <span key={k} className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
            {k}: <span className="font-medium text-foreground">{p[k]}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/**
 * Cost & throughput analytics (spec §10): per-project tasks/done/sessions/cost,
 * a status breakdown, and a 14-day completions bar chart — all derived from
 * sessions + the status-change timeline.
 */
export function Analytics() {
  const a = useQuery({ queryKey: ["analytics"], queryFn: getAnalytics });
  const data = a.data;

  const maxDay = Math.max(1, ...(data?.throughput ?? []).map((d) => d.completed));

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <BarChart3 className="size-5" /> Analytics
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Throughput and effort cost across your projects.
      </p>

      {a.isError ? <p className="mt-4 text-sm text-red-400">Couldn’t load analytics.</p> : null}

      {data ? (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total cost" value={`$${data.totalCostUsd.toFixed(2)}`} />
            <Stat label="Sessions" value={String(data.totalSessions)} />
            <Stat label="Tasks" value={String(data.totalTasks)} />
            <Stat label="Done" value={String(data.doneTasks)} />
          </div>

          <section className="mt-8">
            <h2 className="text-sm font-medium">Completions — last 14 days</h2>
            <div className="mt-3 flex h-32 items-end gap-1">
              {data.throughput.map((d) => (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${d.date}: ${d.completed}`}>
                  <div
                    className="w-full rounded-t bg-primary/70"
                    style={{ height: `${(d.completed / maxDay) * 100}%`, minHeight: d.completed ? "3px" : "0" }}
                  />
                  <span className="text-[9px] text-muted-foreground">{d.date.slice(8)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-medium">By project</h2>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1">Project</th>
                  <th className="py-1 text-right">Tasks</th>
                  <th className="py-1 text-right">Done</th>
                  <th className="py-1 text-right">Sessions</th>
                  <th className="py-1 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.byProject.map((p) => (
                  <tr key={p.projectId ?? "none"} className="border-t border-border">
                    <td className="py-1.5">{p.projectName}</td>
                    <td className="py-1.5 text-right">{p.tasks}</td>
                    <td className="py-1.5 text-right">{p.done}</td>
                    <td className="py-1.5 text-right">{p.sessions}</td>
                    <td className="py-1.5 text-right tabular-nums">${p.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-medium">By status</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(data.byStatus).map(([status, count]) => (
                <span key={status} className="rounded-md bg-muted px-2 py-1 text-xs">
                  {statusLabel(status)}: <span className="font-medium">{count}</span>
                </span>
              ))}
            </div>
          </section>

          <SelfMonitorSection />
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
