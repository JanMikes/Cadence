import type { HealthStatus } from "@cadence/shared";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { LabeledIconButton } from "./components/LabeledIconButton";
import { AppShell } from "./components/AppShell";
import { cn } from "./lib/utils";

type Conn = "connecting" | "online" | "offline";

export function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json() as Promise<HealthStatus>)
      .then((h) => {
        if (cancelled) return;
        setHealth(h);
        setConn(h.ok ? "online" : "offline");
      })
      .catch(() => !cancelled && setConn("offline"));
    return () => {
      cancelled = true;
    };
  }, []);

  const dot = conn === "online" ? "bg-green-500" : conn === "offline" ? "bg-red-500" : "bg-yellow-500";
  const statusText =
    conn === "online" && health
      ? `Connected · ${health.app} v${health.version}`
      : conn === "offline"
        ? "Gateway offline"
        : "Connecting…";

  return (
    <AppShell
      status={
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", dot)} />
          {statusText}
        </span>
      }
    >
      <div className="max-w-3xl p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Your backlog, in flow.</h1>
        <p className="mt-1 text-muted-foreground">
          Phase 0 design base — themed shell, gateway-connected. Real views land in Phase 1.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <LabeledIconButton icon={<Plus />} label="New task" />
          <LabeledIconButton icon={<Search />} label="Search" variant="secondary" />
          <LabeledIconButton
            icon={<RefreshCw />}
            label="Refresh"
            variant="outline"
            onClick={() => window.location.reload()}
          />
        </div>

        <p className="mt-8 text-sm text-muted-foreground">
          Gateway health:{" "}
          {conn === "online" && health ? (
            <span className="text-foreground">ok (schema v{health.version})</span>
          ) : conn === "offline" ? (
            <span className="text-red-400">offline</span>
          ) : (
            "…"
          )}
        </p>
      </div>
    </AppShell>
  );
}
