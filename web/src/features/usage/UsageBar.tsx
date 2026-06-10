import type { UsageWindow } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { getUsage } from "../../lib/api";
import { formatDateTime, formatUntil, useDateFormats } from "../../lib/datetime";
import { cn } from "../../lib/utils";

/** Color the fill by how close the window is to the limit. */
function meterColor(pct: number): string {
  if (pct >= 90) return "bg-red-400";
  if (pct >= 70) return "bg-amber-400";
  return "bg-primary";
}

function WindowMeter({ label, window }: { label: string; window: UsageWindow }) {
  const fmts = useDateFormats();
  const pct = Math.min(100, Math.max(0, window.utilization));
  const resetMs = Date.parse(window.resetsAt);
  return (
    <span
      className="flex items-center gap-2"
      title={`${label}: ${pct}% used · resets ${formatDateTime(resetMs, fmts)}`}
    >
      <span className="font-medium text-foreground/80">{label}</span>
      <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", meterColor(pct))}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={cn("tabular-nums", pct >= 90 ? "text-red-400" : "text-foreground/80")}>
        {Math.round(pct)}%
      </span>
      <span className="text-muted-foreground">resets in {formatUntil(resetMs)}</span>
    </span>
  );
}

/**
 * Ambient subscription-usage bar (spec §10): the same 5-hour session window and weekly
 * window Claude Code's /usage shows, as live meters with reset countdowns. Polls the
 * gateway every 60s; the gateway reads the numbers from the local Claude Code sign-in.
 */
export function UsageBar() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: getUsage, refetchInterval: 60_000 });
  if (!usage.data) return null;

  const w = usage.data.windows;
  return (
    <div className="flex min-w-0 items-center gap-5 text-[11px]">
      <span className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
        <Gauge className="size-3.5" /> Claude usage
      </span>
      {w?.fiveHour ? <WindowMeter label="Session (5h)" window={w.fiveHour} /> : null}
      {w?.sevenDay ? <WindowMeter label="Week" window={w.sevenDay} /> : null}
      {w?.sevenDayOpus ? <WindowMeter label="Opus week" window={w.sevenDayOpus} /> : null}
      {!w?.fiveHour && !w?.sevenDay ? (
        <span
          className="text-muted-foreground"
          title="The gateway reads your local Claude Code sign-in (keychain / ~/.claude) and asks Anthropic for the same window percentages the /usage command shows. Retries every minute."
        >
          usage windows unavailable — retrying every minute
        </span>
      ) : null}
    </div>
  );
}
