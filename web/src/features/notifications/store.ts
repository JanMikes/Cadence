import type { NotifyPayload } from "@cadence/shared";
import { useSyncExternalStore } from "react";
import { subscribe as subscribeWs } from "../../lib/ws";

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  taskId?: string;
  at: number;
  read: boolean;
}

let items: AppNotification[] = [];
const listeners = new Set<() => void>();
let wsWired = false;

function emit() {
  for (const l of listeners) l();
}

/** Add a notification to the in-app list and fire an OS notification if allowed. */
export function addNotification(n: {
  kind: string;
  title: string;
  body: string;
  taskId?: string;
}): void {
  const note: AppNotification = { id: crypto.randomUUID(), at: Date.now(), read: false, ...n };
  items = [note, ...items].slice(0, 100);
  fireDesktop(note);
  emit();
}

function fireDesktop(n: AppNotification): void {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(n.title, { body: n.body });
    } catch {
      /* OS notification failed — the in-app badge still shows it */
    }
  }
}

export function markAllRead(): void {
  if (items.some((i) => !i.read)) {
    items = items.map((i) => ({ ...i, read: true }));
    emit();
  }
}

export function getNotifications(): AppNotification[] {
  return items;
}

export function getUnreadCount(): number {
  return items.reduce((n, i) => n + (i.read ? 0 : 1), 0);
}

function subscribeStore(listener: () => void): () => void {
  if (!wsWired) {
    wsWired = true;
    subscribeWs((m) => {
      if (m.type === "event" && m.name === "notify") {
        const p = m.payload as NotifyPayload;
        addNotification({ kind: p.kind, title: p.title, body: p.message, taskId: p.taskId });
      }
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to the notification list. */
export function useNotifications(): AppNotification[] {
  return useSyncExternalStore(subscribeStore, getNotifications, getNotifications);
}

/** Test-only: clear the store. */
export function _resetNotifications(): void {
  items = [];
  emit();
}
