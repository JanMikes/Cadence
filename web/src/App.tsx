import type { HealthStatus } from "@cadence/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppShell, type ViewId } from "./components/AppShell";
import { Analytics } from "./features/analytics/Analytics";
import { AttentionCenter } from "./features/attention/AttentionCenter";
import { AttentionPill } from "./features/attention/AttentionPill";
import { Board } from "./features/board/Board";
import { Calendar } from "./features/calendar/Calendar";
import { Today } from "./features/digest/Today";
import { Fleets } from "./features/fleets/Fleets";
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
import { ATTENTION_SHORTCUT } from "./lib/shortcuts";
import { useTauriBridge } from "./lib/tauri";
import { cn } from "./lib/utils";
import { useServerMessages } from "./lib/ws";

type Conn = "connecting" | "online" | "offline";

// Server events that change what's waiting on the user → refresh the "needs you" feed
// (and the board). Keeps the top-bar pill and the Attention Center live.
const ATTENTION_EVENTS = new Set([
  "task:updated",
  "task:play",
  "task:plan",
  "task:ready",
  "task:triaged",
  "task:implemented",
  "task:verified",
  "task:delivered",
  "approval:requested",
  "approval:resolved",
  "notify",
]);

export function App() {
  const [view, setView] = useState<ViewId>("today");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDetailId, setSessionDetailId] = useState<string | null>(null);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const notifications = useNotifications();
  const unread = notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0);
  const qc = useQueryClient();

  // Live-refresh the session lists, rolled-up task cost, and any open session detail as agent
  // stages record themselves and finish (the deep counterpart to the board's activity spinner).
  useServerMessages((msg) => {
    if (
      msg.type === "event" &&
      (msg.name === "session:spawned" ||
        msg.name === "session:updated" ||
        msg.name === "session:deleted" ||
        msg.name === "session:closed")
    ) {
      void qc.invalidateQueries({ queryKey: ["sessions", "all"] });
      void qc.invalidateQueries({ queryKey: ["task"] });
      void qc.invalidateQueries({ queryKey: ["session"] });
    }
    if (msg.type === "event" && ATTENTION_EVENTS.has(msg.name)) {
      void qc.invalidateQueries({ queryKey: ["attention"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    }
    // Project changes (edits, worktree-readiness verdicts) → refresh the projects list
    // so open views (e.g. the project drawer) show the new state live.
    if (
      msg.type === "event" &&
      (msg.name === "project:created" || msg.name === "project:updated")
    ) {
      void qc.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  // Native global hotkey / tray "Quick capture" → open the capture modal (inert in a plain browser).
  useTauriBridge(() => setAddTaskOpen(true));

  // In-app shortcut: ⌘⇧A toggles the "needs you" Attention Center (shown on the pill).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ATTENTION_SHORTCUT.matches(e)) {
        e.preventDefault();
        setAttentionOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        topBar={
          <div className="flex items-center gap-3 border-b border-border bg-card/30 px-4 py-1.5">
            <div className="min-w-0 flex-1">
              <UsageBar />
            </div>
            <AttentionPill onOpen={() => setAttentionOpen(true)} />
          </div>
        }
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
        onOpenAttention={() => setAttentionOpen(true)}
      />

      <AddTaskModal open={addTaskOpen} onOpenChange={setAddTaskOpen} />

      {attentionOpen ? (
        <AttentionCenter
          onClose={() => setAttentionOpen(false)}
          onOpenSession={setActiveSessionId}
          onOpenSessionDetail={setSessionDetailId}
          onOpenTask={(id) => {
            setAttentionOpen(false);
            setSelectedId(id);
          }}
        />
      ) : null}
    </>
  );
}
