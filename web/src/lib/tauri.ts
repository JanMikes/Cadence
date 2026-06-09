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
  notification?: {
    sendNotification?: (notification: { title: string; body?: string } | string) => void;
    isPermissionGranted?: () => Promise<boolean>;
    requestPermission?: () => Promise<string>;
  };
  core?: {
    invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
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
 * Raise a real OS notification via the Tauri shell. Returns `true` if handled (inside Tauri), `false`
 * in a plain browser so the caller can fall back to the Web Notifications API. Permission is requested
 * once by `useTauriBridge`; an un-granted notification simply no-ops at the OS layer.
 */
export function tauriNotify(title: string, body?: string): boolean {
  const send = tauriGlobal()?.notification?.sendNotification;
  if (!send) return false;
  send(body ? { title, body } : { title });
  return true;
}

/** Whether "Launch at login" (autostart) is currently enabled — `null` outside the Tauri shell. */
export async function getAutostart(): Promise<boolean | null> {
  const invoke = tauriGlobal()?.core?.invoke;
  if (!invoke) return null;
  try {
    return (await invoke("plugin:autostart|is_enabled")) as boolean;
  } catch {
    return null;
  }
}

/** Enable/disable "Launch at login" (autostart). Returns `true` if handled (inside the Tauri shell). */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  const invoke = tauriGlobal()?.core?.invoke;
  if (!invoke) return false;
  try {
    await invoke(enabled ? "plugin:autostart|enable" : "plugin:autostart|disable");
    return true;
  } catch {
    return false;
  }
}

/**
 * React wiring for the native bridge: opens quick-capture from the global hotkey / tray. Subscribes
 * once and always calls the latest `onQuickCapture` (via a ref), so an inline callback won't churn the
 * subscription. Inert outside the Tauri shell.
 */
/** Ask for OS notification permission once so `tauriNotify` banners can show. No-op outside Tauri. */
function ensureNotificationPermission(): void {
  const n = tauriGlobal()?.notification;
  if (!n?.isPermissionGranted || !n.requestPermission) return;
  void n.isPermissionGranted().then((granted) => {
    if (!granted) void n.requestPermission?.();
  });
}

export function useTauriBridge(onQuickCapture: () => void): void {
  const cb = useRef(onQuickCapture);
  cb.current = onQuickCapture;
  useEffect(() => {
    ensureNotificationPermission();
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
