import type { NotifyPayload, Task, TaskGitContext } from "@cadence/shared";
import type { WorktreeCheckOutcome } from "./agents/worktree-check";
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

/**
 * Notify when the git-context sweep discovers a task's branch was merged outside
 * Cadence (terminal merge, forge PR/MR merge). Propose, don't impose: a task still
 * in review is nudged toward "mark it done" — its status never flips silently.
 */
export function notifyGitMergedExternally(
  hub: WsHub,
  task: Pick<Task, "id" | "title" | "status">,
  ctx: TaskGitContext,
): NotifyPayload {
  const where = ctx.mergedVia === "forge" ? "PR/MR merged" : "Branch merged outside Cadence";
  const payload: NotifyPayload = {
    kind: "info",
    title: where,
    message:
      task.status === "review" ? `${task.title} — open it to mark the task done` : task.title,
    taskId: task.id,
  };
  hub.broadcast({ type: "event", name: "notify", payload });
  return payload;
}

/**
 * Notify when a worktree-readiness check finishes (it's fire-and-forget and can take a
 * while — the user may long since have closed the panel that started it). The verdict
 * itself is persisted on the project; this just makes sure it isn't missed.
 */
export function notifyWorktreeCheck(
  hub: WsHub,
  projectName: string,
  out: WorktreeCheckOutcome,
): NotifyPayload {
  let payload: NotifyPayload;
  if (!out.ran || !out.check) {
    payload = {
      kind: "info",
      title: "Worktree check failed",
      message: `${projectName}: ${out.reason ?? "unknown reason"}`,
    };
  } else if (out.check.verdict === "ready") {
    payload = { kind: "info", title: "Worktree check finished", message: `${projectName}: ready for worktrees` };
  } else {
    const n = out.check.blockers.length;
    payload = {
      kind: "info",
      title: "Worktree check finished",
      message: `${projectName}: ${n} blocker${n === 1 ? "" : "s"} found`,
    };
  }
  hub.broadcast({ type: "event", name: "notify", payload });
  return payload;
}
