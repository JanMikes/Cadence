import type { HealthStatus } from "@cadence/shared";
import { useEffect, useState } from "react";
import { AppShell, type ViewId } from "./components/AppShell";
import { Analytics } from "./features/analytics/Analytics";
import { ApprovalsBar } from "./features/approvals/ApprovalsBar";
import { Board } from "./features/board/Board";
import { Calendar } from "./features/calendar/Calendar";
import { Today } from "./features/digest/Today";
import { Fleets } from "./features/fleets/Fleets";
import { Inbox } from "./features/inbox/Inbox";
import { Memory } from "./features/memory/Memory";
import { Projects } from "./features/projects/Projects";
import { SessionDetail } from "./features/session/SessionDetail";
import { SessionPanel } from "./features/session/SessionPanel";
import { NotificationsView } from "./features/notifications/NotificationsView";
import { useNotifications } from "./features/notifications/store";
import { CommandPalette } from "./features/search/CommandPalette";
import { SessionsView } from "./features/sessions/SessionsView";
import { SettingsView } from "./features/settings/SettingsView";
import { AddTaskButton, AddTaskModal } from "./features/task/AddTaskModal";
import { TaskDetail } from "./features/task/TaskDetail";
import { UsageBar } from "./features/usage/UsageBar";
import { useTauriBridge } from "./lib/tauri";
import { cn } from "./lib/utils";

type Conn = "connecting" | "online" | "offline";

export function App() {
  const [view, setView] = useState<ViewId>("today");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDetailId, setSessionDetailId] = useState<string | null>(null);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const notifications = useNotifications();
  const unread = notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0);

  // Native global hotkey / tray "Quick capture" → open the capture modal (inert in a plain browser).
  useTauriBridge(() => setAddTaskOpen(true));

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
        primaryAction={<AddTaskButton onClick={() => setAddTaskOpen(true)} />}
        status={
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", dot)} />
            {statusText}
          </span>
        }
      >
        {view === "today" ? <Today onOpen={setSelectedId} /> : null}
        {view === "inbox" ? <Inbox onOpen={setSelectedId} /> : null}
        {view === "board" ? <Board onOpen={setSelectedId} /> : null}
        {view === "calendar" ? <Calendar onOpenTask={setSelectedId} /> : null}
        {view === "projects" ? <Projects /> : null}
        {view === "fleets" ? <Fleets /> : null}
        {view === "sessions" ? <SessionsView onOpenSessionDetail={setSessionDetailId} /> : null}
        {view === "analytics" ? <Analytics /> : null}
        {view === "memory" ? <Memory /> : null}
        {view === "notifications" ? <NotificationsView onOpenTask={setSelectedId} /> : null}
        {view === "settings" ? <SettingsView /> : null}
      </AppShell>

      {selectedId ? (
        <TaskDetail
          taskId={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenSession={setActiveSessionId}
          onOpenSessionDetail={setSessionDetailId}
          onOpenTask={setSelectedId}
        />
      ) : null}

      {sessionDetailId ? (
        <SessionDetail
          sessionId={sessionDetailId}
          onClose={() => setSessionDetailId(null)}
          onContinue={(id) => {
            setSessionDetailId(null);
            setActiveSessionId(id);
          }}
          onOpenTask={(id) => {
            setSessionDetailId(null);
            setSelectedId(id);
          }}
        />
      ) : null}

      {activeSessionId ? (
        <SessionPanel sessionId={activeSessionId} onClose={() => setActiveSessionId(null)} />
      ) : null}

      <CommandPalette
        onOpenTask={setSelectedId}
        onNavigate={(v) => {
          setView(v);
          setSelectedId(null);
        }}
        onAddTask={() => setAddTaskOpen(true)}
      />

      <AddTaskModal open={addTaskOpen} onOpenChange={setAddTaskOpen} />

      <ApprovalsBar />
    </>
  );
}
