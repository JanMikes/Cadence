import type { NotifyPayload, Task } from "@cadence/shared";
import type { WsHub } from "./ws";

/**
 * Emit a `notify` event when a task crosses into an attention-worthy state
 * (§10: pull attention to ❓ and delivered). Returns the payload sent, or null.
 */
export function notifyOnTransition(
  hub: WsHub,
  oldStatus: string | undefined,
  task: Task,
): NotifyPayload | null {
  let payload: NotifyPayload | null = null;

  if (oldStatus !== "needs_feedback" && task.status === "needs_feedback") {
    payload = { kind: "needs_feedback", title: "Needs your input", message: task.title, taskId: task.id };
  } else if (oldStatus !== "done" && task.status === "done") {
    payload = { kind: "delivered", title: "Task delivered", message: task.title, taskId: task.id };
  }

  if (payload) hub.broadcast({ type: "event", name: "notify", payload });
  return payload;
}
