import { useEffect, useRef } from "react";

/**
 * Feature-detected bridge to the Tauri native shell. The same web build runs in a plain browser tab
 * AND inside Cadence.app; everything here is a no-op unless `window.__TAURI__` is present (injected by
 * `app.withGlobalTauri = true`), so the browser build is completely unchanged.
 */

/** Minimal shape of the `withGlobalTauri` global we rely on. */
type TauriGlobal = {
  event?: {
    listen?: (event: string, handler: (e: unknown) => void) => Promise<() => void>;
  };
};

function tauriGlobal(): TauriGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/** Are we running inside the Tauri shell (vs a plain browser tab)? */
export function isTauri(): boolean {
  return tauriGlobal() !== undefined;
}

/**
 * Listen for the native "quick-capture" event (fired by the global hotkey / tray "Quick capture") and
 * run `onCapture`. Returns an unlisten fn, or `null` in a plain browser (no `__TAURI__`) — the inert path.
 */
export function subscribeQuickCapture(onCapture: () => void): Promise<(() => void) | null> {
  const listen = tauriGlobal()?.event?.listen;
  if (!listen) return Promise.resolve(null);
  return listen("quick-capture", () => onCapture());
}

/**
 * React wiring for the native bridge: opens quick-capture from the global hotkey / tray. Subscribes
 * once and always calls the latest `onQuickCapture` (via a ref), so an inline callback won't churn the
 * subscription. Inert outside the Tauri shell.
 */
export function useTauriBridge(onQuickCapture: () => void): void {
  const cb = useRef(onQuickCapture);
  cb.current = onQuickCapture;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let active = true;
    void subscribeQuickCapture(() => cb.current()).then((u) => {
      if (active) unlisten = u;
      else u?.(); // unmounted before the listener resolved
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
}
