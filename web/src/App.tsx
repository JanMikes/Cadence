import type { HealthStatus } from "@cadence/shared";
import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { Inbox } from "./features/inbox/Inbox";
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
      <Inbox />
    </AppShell>
  );
}
