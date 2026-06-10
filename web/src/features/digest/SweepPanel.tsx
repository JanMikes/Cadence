import { useQuery } from "@tanstack/react-query";
import { AlarmClock, CheckCircle2, Clock } from "lucide-react";
import { getSweep } from "../../lib/api";

/**
 * Proactive nudges from the background sweep (spec §8): tasks idling too long and
 * deadlines at risk. Propose-don't-impose — surfaced here in Today, click to open.
 * An explicit all-clear line keeps the check visible (and trustworthy) on quiet days.
 */
export function SweepPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const sweep = useQuery({ queryKey: ["sweep"], queryFn: getSweep });
  if (!sweep.data) return null;
  const findings = sweep.data.findings;
  if (findings.length === 0) {
    return (
      <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-400" />
        Checked your backlog — nothing stale or at deadline risk.
      </p>
    );
  }

  return (
    <section className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-amber-300">
        <AlarmClock className="size-4" /> Needs attention ({findings.length})
      </h2>
      <ul className="mt-2 flex flex-col gap-1.5">
        {findings.map((f) => (
          <li key={`${f.kind}:${f.taskId}`}>
            <button
              type="button"
              onClick={() => onOpen(f.taskId)}
              className="flex w-full items-center gap-2 rounded border border-border bg-card/60 px-2 py-1.5 text-left text-xs hover:border-primary/50"
            >
              <Clock className={`size-3.5 ${f.kind === "at_risk" ? "text-red-400" : "text-muted-foreground"}`} />
              <span className="flex-1 truncate">{f.title}</span>
              <span className={f.kind === "at_risk" ? "text-red-400" : "text-muted-foreground"}>
                {f.detail}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
