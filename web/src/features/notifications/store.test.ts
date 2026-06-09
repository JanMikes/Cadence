import { expect, test } from "bun:test";
import {
  _resetNotifications,
  addNotification,
  getNotifications,
  getUnreadCount,
  markAllRead,
} from "./store";

test("addNotification prepends, tracks unread, markAllRead clears the badge", () => {
  _resetNotifications();
  expect(getUnreadCount()).toBe(0);

  addNotification({ kind: "needs_feedback", title: "Needs your input", body: "Answer me", taskId: "t1" });
  addNotification({ kind: "delivered", title: "Task delivered", body: "Ship it" });

  const items = getNotifications();
  expect(items).toHaveLength(2);
  expect(items[0]?.title).toBe("Task delivered"); // newest first
  expect(items[0]?.read).toBe(false);
  expect(getUnreadCount()).toBe(2);

  markAllRead();
  expect(getUnreadCount()).toBe(0);
  expect(getNotifications().every((i) => i.read)).toBe(true);
  _resetNotifications();
});

test("addNotification raises a native banner inside the Tauri shell", () => {
  _resetNotifications();
  const sent: Array<{ title: string; body?: string } | string> = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI__: {
      notification: {
        sendNotification: (o: { title: string; body?: string } | string) => sent.push(o),
      },
    },
  };
  try {
    addNotification({ kind: "needs_feedback", title: "Needs your input", body: "Answer the question" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "Needs your input", body: "Answer the question" });
  } finally {
    delete (globalThis as { window?: unknown }).window;
    _resetNotifications();
  }
});

test("addNotification falls back to the web path (no throw) outside the Tauri shell", () => {
  _resetNotifications();
  // No __TAURI__ and Notification is undefined under bun → fireDesktop no-ops gracefully.
  expect(() =>
    addNotification({ kind: "delivered", title: "Delivered", body: "Branch ready for review" }),
  ).not.toThrow();
  _resetNotifications();
});
