import { useCallback, useEffect, useState } from "react";
import type { ViewId } from "../components/AppShell";

// Hash-based routing (no router dependency): the active view — and, when a task
// detail modal is open, its id — live in `window.location.hash` so a page refresh
// or browser back/forward lands where you were instead of resetting to "/".
// Scheme: `#board` (view) · `#board?task=<id>` (view + open task detail).
// Transient overlays (session panels, capture modal, attention center) stay in
// memory on purpose — restoring them after a refresh would be more confusing
// than helpful.

export interface Route {
  view: ViewId;
  taskId: string | null;
}

const VIEW_IDS: ReadonlySet<string> = new Set<ViewId>([
  "today",
  "board",
  "calendar",
  "recurring",
  "projects",
  "fleets",
  "sessions",
  "analytics",
  "memory",
  "notifications",
  "settings",
  "quickstart",
]);

export const DEFAULT_VIEW: ViewId = "today";

/** Parse a location hash (with or without the leading `#`) into a route.
 *  Unknown or empty views fall back to the default view; a `task` param is
 *  only honored alongside a recognized view (a mangled hash restores cleanly). */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = raw.indexOf("?");
  const viewPart = q === -1 ? raw : raw.slice(0, q);
  if (!VIEW_IDS.has(viewPart)) return { view: DEFAULT_VIEW, taskId: null };
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  return { view: viewPart as ViewId, taskId: params.get("task") };
}

/** Format a route back into a hash fragment (no leading `#`). */
export function formatHash(route: Route): string {
  if (!route.taskId) return route.view;
  const params = new URLSearchParams({ task: route.taskId });
  return `${route.view}?${params.toString()}`;
}

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/** Owns the routable part of the app state. Reads the hash once on mount,
 *  rewrites it on navigation (each step is a history entry, so back/forward
 *  walk through views), and follows external hash changes (back button,
 *  hand-edited URL) via `hashchange`. */
export function useHashRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(currentHash()));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Partial<Route>) => {
    setRoute((cur) => {
      const merged: Route = { ...cur, ...next };
      if (typeof window !== "undefined") {
        const target = formatHash(merged);
        if (window.location.hash.slice(1) !== target) window.location.hash = target;
      }
      return merged;
    });
  }, []);

  return [route, navigate];
}
