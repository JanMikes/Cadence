import type { NotifyPayload, Task } from "@cadence/shared";
import type { WsHub } from "./ws";

/**
 * Emit a `notify` event when a task crosses into an attention-worthy state — every
 * point where Cadence needs the user (§10): questions to answer, a plan to approve,
 * a result to merge, and delivery. Returns the payload sent, or null.
 */
export function notifyOnTransition(
  hub: WsHub,
  oldStatus: string | undefined,
  task: Task,
): NotifyPayload | null {
  let payload: NotifyPayload | null = null;

  if (oldStatus !== "needs_feedback" && task.status === "needs_feedback") {
    payload = { kind: "needs_feedback", title: "Needs your input", message: task.title, taskId: task.id };
  } else if (oldStatus !== "plan_review" && task.status === "plan_review") {
    payload = { kind: "plan_review", title: "Plan ready for review", message: task.title, taskId: task.id };
  } else if (oldStatus !== "review" && task.status === "review") {
    payload = { kind: "review", title: "Ready to merge", message: task.title, taskId: task.id };
  } else if (oldStatus !== "done" && task.status === "done") {
    payload = { kind: "delivered", title: "Task delivered", message: task.title, taskId: task.id };
  }

  if (payload) hub.broadcast({ type: "event", name: "notify", payload });
  return payload;
}
