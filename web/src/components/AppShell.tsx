import { Inbox, LayoutGrid, Settings, Sparkles } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

export type ViewId = "inbox" | "board" | "settings";

interface NavItem {
  id: ViewId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

// Left-nav. Every item is labeled (icon + text), per the UX-clarity rules (§10.1).
const NAV: NavItem[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "settings", label: "Settings", icon: Settings },
];

export interface AppShellProps {
  children: ReactNode;
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  /** Small status line shown at the bottom of the nav (e.g. gateway health). */
  status?: ReactNode;
}

export function AppShell({ children, activeView, onNavigate, status }: AppShellProps) {
  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card/40">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Sparkles className="size-5 text-primary" />
          <span className="font-semibold tracking-tight">Cadence</span>
        </div>

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

      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
