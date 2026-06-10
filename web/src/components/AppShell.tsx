import {
  Activity,
  BarChart3,
  Bell,
  Boxes,
  BrainCircuit,
  CalendarDays,
  FolderGit2,
  LayoutGrid,
  Settings,
  Sparkles,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

export type ViewId =
  | "today"
  | "board"
  | "calendar"
  | "projects"
  | "fleets"
  | "sessions"
  | "analytics"
  | "memory"
  | "notifications"
  | "settings";

interface NavItem {
  id: ViewId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

// Left-nav. Every item is labeled (icon + text), per the UX-clarity rules (§10.1).
// The Inbox view was removed in 6.2: capture lives in the global AddTaskModal and
// inbox-status tasks appear as the Board's first column — one place to look.
const NAV: NavItem[] = [
  { id: "today", label: "Today", icon: Sparkles },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "fleets", label: "Fleets", icon: Boxes },
  { id: "sessions", label: "Sessions", icon: Activity },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "memory", label: "Memory", icon: BrainCircuit },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "settings", label: "Settings", icon: Settings },
];

export interface AppShellProps {
  children: ReactNode;
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  /** Small status line shown at the bottom of the nav (e.g. gateway health). */
  status?: ReactNode;
  /** Ambient bar pinned above the scrolling content (e.g. the usage bar). */
  topBar?: ReactNode;
  /** Unread-count badges per nav item (e.g. notifications). */
  navBadges?: Partial<Record<ViewId, number>>;
  /** Prominent action pinned under the logo, above the nav (e.g. "Add task"). */
  primaryAction?: ReactNode;
}

export function AppShell({
  children,
  activeView,
  onNavigate,
  status,
  topBar,
  navBadges,
  primaryAction,
}: AppShellProps) {
  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card/40">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <img src="/cadence-icon.png" alt="" className="size-6 rounded-md" />
          <span className="font-semibold tracking-tight">Cadence</span>
        </div>

        {primaryAction ? <div className="px-2 pt-2">{primaryAction}</div> : null}

        <nav className="flex flex-col gap-1 p-2">
          {NAV.map((item) => {
            const active = item.id === activeView;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <item.icon className="size-4" />
                <span>{item.label}</span>
                {navBadges?.[item.id] ? (
                  <span className="ml-auto inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                    {navBadges[item.id]}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        {status ? (
          <div className="mt-auto border-t border-border p-3 text-xs text-muted-foreground">
            {status}
          </div>
        ) : null}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {topBar}
        <div className="flex-1 overflow-auto">{children}</div>
      </main>
    </div>
  );
}
