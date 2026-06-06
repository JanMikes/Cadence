import type { HealthStatus } from "@cadence/shared";
import { useEffect, useState } from "react";
import { AppShell, type ViewId } from "./components/AppShell";
import { Board } from "./features/board/Board";
import { Inbox } from "./features/inbox/Inbox";
import { Projects } from "./features/projects/Projects";
import { SessionPanel } from "./features/session/SessionPanel";
import { NotificationsView } from "./features/notifications/NotificationsView";
import { useNotifications } from "./features/notifications/store";
import { SessionsView } from "./features/sessions/SessionsView";
import { SettingsView } from "./features/settings/SettingsView";
import { TaskDetail } from "./features/task/TaskDetail";
import { UsageBar } from "./features/usage/UsageBar";
import { cn } from "./lib/utils";

type Conn = "connecting" | "online" | "offline";

export function App() {
  const [view, setView] = useState<ViewId>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const notifications = useNotifications();
  const unread = notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0);

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
        topBar={<UsageBar />}
        navBadges={{ notifications: unread }}
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
        {view === "sessions" ? <SessionsView /> : null}
        {view === "notifications" ? <NotificationsView onOpenTask={setSelectedId} /> : null}
        {view === "settings" ? <SettingsView /> : null}
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
