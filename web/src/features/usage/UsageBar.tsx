import type { UsageWindow } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { getUsage } from "../../lib/api";
import { formatDateTime, formatUntil, useDateFormats } from "../../lib/datetime";
import { cn } from "../../lib/utils";
import { useConnectionStatus } from "../../lib/ws";

/** Color the fill by how close the window is to the limit. */
function meterColor(pct: number): string {
  if (pct >= 90) return "bg-red-400";
  if (pct >= 70) return "bg-amber-400";
  return "bg-primary";
}

/** A full-width stacked meter row for the narrow sidebar. */
function SidebarMeter({ label, window }: { label: string; window: UsageWindow }) {
  const fmts = useDateFormats();
  const pct = Math.min(100, Math.max(0, window.utilization));
  const resetMs = Date.parse(window.resetsAt);
  return (
    <div
      className="flex flex-col gap-1"
      title={`${label}: ${pct}% used · resets in ${formatUntil(resetMs)} (${formatDateTime(resetMs, fmts)})`}
    >
      <span className="flex items-center justify-between">
        <span className="font-medium text-foreground/80">{label}</span>
        <span className={cn("tabular-nums", pct >= 90 ? "text-red-400" : "text-foreground/80")}>
          {Math.round(pct)}%
        </span>
      </span>
      <span className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", meterColor(pct))}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/**
 * Sidebar-bottom variant: the same usage windows stacked vertically for the 224px aside.
 * Dimmed (and marked) while the gateway connection is down — the numbers may be stale,
 * and we never present stale data as fresh. Carries the small version line the old
 * "Connected" status row used to show.
 */
export function SidebarUsage() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: getUsage, refetchInterval: 60_000 });
  const conn = useConnectionStatus();
  const stale = conn.state !== "connected";
  if (!usage.data) return null;

  const w = usage.data.windows;
  return (
    <div className="flex flex-col gap-2.5 text-[11px]">
      <span className="flex items-center gap-1 font-medium text-muted-foreground">
        <Gauge className="size-3.5" /> Claude usage
        {stale ? <span className="ml-auto text-amber-400/90">may be stale</span> : null}
      </span>
      <div className={cn("flex flex-col gap-2.5", stale && "opacity-50")} title={stale ? "Gateway connection is down — these numbers may be stale." : undefined}>
        {w?.fiveHour ? <SidebarMeter label="Session (5h)" window={w.fiveHour} /> : null}
        {w?.sevenDay ? <SidebarMeter label="Week" window={w.sevenDay} /> : null}
        {w?.sevenDayOpus ? <SidebarMeter label="Opus week" window={w.sevenDayOpus} /> : null}
        {!w?.fiveHour && !w?.sevenDay ? (
          <span
            className="text-muted-foreground"
            title="The gateway reads your local Claude Code sign-in (keychain / ~/.claude) and asks Anthropic for the same window percentages the /usage command shows. Retries every minute."
          >
            usage windows unavailable — retrying every minute
          </span>
        ) : null}
      </div>
      {conn.server ? (
        <span className="text-[10px] text-muted-foreground/70">
          {conn.server.app} v{conn.server.version}
        </span>
      ) : null}
    </div>
  );
}
