import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerDownLeft, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import type { ViewId } from "../../components/AppShell";
import { createSavedSearch, getSavedSearches, search, searchTranscripts } from "../../lib/api";
import { cn } from "../../lib/utils";

interface PaletteItem {
  id: string;
  label: string;
  sub?: string;
  /** Return true to keep the palette open after running (e.g. apply a saved query). */
  run: () => void | boolean;
}

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: "today", label: "Go to Today" },
  { id: "board", label: "Go to Board" },
  { id: "calendar", label: "Go to Calendar" },
  { id: "projects", label: "Go to Projects" },
  { id: "fleets", label: "Go to Fleets" },
  { id: "sessions", label: "Go to Sessions" },
  { id: "analytics", label: "Go to Analytics" },
  { id: "memory", label: "Go to Memory" },
  { id: "notifications", label: "Go to Notifications" },
  { id: "settings", label: "Go to Settings" },
  { id: "quickstart", label: "Go to How it works" },
];

/** ⌘K / Ctrl+K command palette: full-text task search + jump-to actions (§10). */
export function CommandPalette({
  onOpenTask,
  onNavigate,
  onAddTask,
  onOpenAttention,
}: {
  onOpenTask: (taskId: string) => void;
  onNavigate: (view: ViewId) => void;
  /** Optional quick-action: open the Add-task modal. */
  onAddTask?: () => void;
  /** Optional quick-action: open the "needs you" Attention Center. */
  onOpenAttention?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
    }
  }, [open]);

  const qc = useQueryClient();
  const results = useQuery({
    queryKey: ["search", q],
    queryFn: () => search(q),
    enabled: open && q.trim().length > 0,
  });
  const transcripts = useQuery({
    queryKey: ["search", "transcripts", q],
    queryFn: () => searchTranscripts(q),
    enabled: open && q.trim().length > 0,
  });
  const saved = useQuery({ queryKey: ["searches"], queryFn: getSavedSearches, enabled: open });

  if (!open) return null;

  const ql = q.toLowerCase();
  const quickActions: PaletteItem[] = [
    ...(onAddTask && "add task".includes(ql)
      ? [{ id: "action:add-task", label: "Add task", sub: "C", run: () => onAddTask() }]
      : []),
    ...(onOpenAttention && "needs you open attention".includes(ql)
      ? [{ id: "action:attention", label: "Needs you — open attention", run: () => onOpenAttention() }]
      : []),
  ];
  const actions: PaletteItem[] = NAV.filter((n) => n.label.toLowerCase().includes(ql)).map((n) => ({
    id: `nav:${n.id}`,
    label: n.label,
    run: () => onNavigate(n.id),
  }));
  const taskItems: PaletteItem[] = (results.data ?? []).map((h) => ({
    id: `task:${h.taskId}`,
    label: h.title,
    sub: h.status,
    run: () => onOpenTask(h.taskId),
  }));
  const transcriptItems: PaletteItem[] = (transcripts.data ?? [])
    .filter((h) => h.taskId)
    .map((h) => ({
      id: `transcript:${h.sessionId}`,
      label: h.snippet,
      sub: "transcript",
      run: () => {
        if (h.taskId) onOpenTask(h.taskId);
      },
    }));

  const hasQuery = q.trim().length > 0;
  const saveItem: PaletteItem[] = hasQuery
    ? [
        {
          id: "save-search",
          label: `★ Save search “${q.trim()}”`,
          run: () => {
            void createSavedSearch(q.trim(), q.trim()).then(() =>
              qc.invalidateQueries({ queryKey: ["searches"] }),
            );
          },
        },
      ]
    : [];
  const savedItems: PaletteItem[] = hasQuery
    ? []
    : (saved.data ?? []).map((s) => ({
        id: `saved:${s.id}`,
        label: s.name,
        sub: "saved · " + s.query,
        run: () => {
          setQ(s.query);
          setActive(0);
          return true; // keep the palette open to show the applied query's results
        },
      }));

  const items = hasQuery
    ? [...taskItems, ...transcriptItems, ...quickActions, ...actions, ...saveItem]
    : [...quickActions, ...savedItems, ...actions];

  const close = () => setOpen(false);
  const select = (i: number) => {
    const it = items[i];
    if (it) {
      const keepOpen = it.run();
      if (!keepOpen) close();
    }
  };

  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(active);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (global handler); backdrop is a convenience
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          {/* biome-ignore lint/a11y/noAutofocus: the palette exists to be typed in immediately */}
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            autoFocus
            placeholder="Search tasks or jump to…"
            aria-label="Command palette"
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul className="max-h-80 overflow-auto border-t border-border p-1">
          {items.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {q.trim() ? "No matches." : "Type to search tasks, or jump to a view."}
            </li>
          ) : null}
          {items.map((it, i) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => select(i)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm",
                  i === active ? "bg-accent text-foreground" : "text-foreground/90",
                )}
              >
                <span className="truncate">{it.label}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {it.sub}
                  {i === active ? <CornerDownLeft className="size-3" /> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
