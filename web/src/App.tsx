import type { HealthStatus } from "@cadence/shared";
import { useEffect, useState } from "react";
import { AppShell, type ViewId } from "./components/AppShell";
import { Board } from "./features/board/Board";
import { Inbox } from "./features/inbox/Inbox";
import { Projects } from "./features/projects/Projects";
import { SessionPanel } from "./features/session/SessionPanel";
import { TaskDetail } from "./features/task/TaskDetail";
import { cn } from "./lib/utils";

type Conn = "connecting" | "online" | "offline";

export function App() {
  const [view, setView] = useState<ViewId>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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
    <>
      <AppShell
        activeView={view}
        onNavigate={(v) => {
          setView(v);
          setSelectedId(null);
        }}
        status={
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", dot)} />
            {statusText}
          </span>
        }
      >
        {view === "inbox" ? <Inbox onOpen={setSelectedId} /> : null}
        {view === "board" ? <Board onOpen={setSelectedId} /> : null}
        {view === "projects" ? <Projects /> : null}
        {view === "settings" ? (
          <div className="p-8 text-sm text-muted-foreground">Settings — coming soon.</div>
        ) : null}
      </AppShell>

      {selectedId ? (
        <TaskDetail
          taskId={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenSession={setActiveSessionId}
        />
      ) : null}

      {activeSessionId ? (
        <SessionPanel sessionId={activeSessionId} onClose={() => setActiveSessionId(null)} />
      ) : null}
    </>
  );
}
