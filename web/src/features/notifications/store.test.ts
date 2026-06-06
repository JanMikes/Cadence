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
