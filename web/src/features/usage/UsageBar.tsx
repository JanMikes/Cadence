import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { getUsage } from "../../lib/api";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Ambient, non-noisy usage bar (subscription windows) — spec §10. */
export function UsageBar() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: getUsage, refetchInterval: 30_000 });
  const s = usage.data?.stats;
  if (!s) return null;

  const rl = usage.data?.rateLimit as Record<string, unknown> | null;

  return (
    <div className="flex items-center gap-4 border-b border-border bg-card/30 px-4 py-1.5 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1 font-medium">
        <Activity className="size-3.5" /> Usage
      </span>
      <span>
        This week: <span className="text-foreground/80">{s.week.sessions}</span> sessions ·{" "}
        <span className="text-foreground/80">{fmtTokens(s.week.tokens)}</span> tokens ·{" "}
        {s.week.messages.toLocaleString()} msgs
      </span>
      {s.topModels[0] ? <span>top: {s.topModels[0].model}</span> : null}
      {rl ? <span className="text-foreground/80">rate-limit info live</span> : null}
      <span className="ml-auto">{s.totalSessions.toLocaleString()} sessions all-time</span>
    </div>
  );
}
