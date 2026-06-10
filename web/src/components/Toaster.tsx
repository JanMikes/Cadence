import { useSyncExternalStore } from "react";

export interface ToastItem {
  id: string;
  message: string;
}

let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const TOAST_MS = 6000;

function emit() {
  for (const l of listeners) l();
}

/** Show a transient in-app toast (bottom-center, auto-dismisses). For ambient
 *  confirmations of actions the user just took — no OS banner, no bell entry. */
export function toast(message: string): void {
  const item: ToastItem = { id: crypto.randomUUID(), message };
  toasts = [...toasts, item].slice(-3);
  timers.set(
    item.id,
    setTimeout(() => dismissToast(item.id), TOAST_MS),
  );
  emit();
}

export function dismissToast(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  if (toasts.some((i) => i.id === id)) {
    toasts = toasts.filter((i) => i.id !== id);
    emit();
  }
}

export function getToasts(): ToastItem[] {
  return toasts;
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear all toasts + timers. */
export function _resetToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  toasts = [];
  emit();
}

/** Mount once at the app root; renders the active toasts above all modals. */
export function Toaster() {
  const items = useSyncExternalStore(subscribeStore, getToasts, getToasts);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[90] flex flex-col items-center gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-sm shadow-2xl"
        >
          <span>{t.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
