import { TASK_STATUSES } from "@cadence/shared";

/**
 * The lifecycle state machine (spec §6). Enforced server-side on manual status
 * changes (the board drag / detail editor). It is deliberately *permissive
 * inside the active workflow* — this is a single-user kanban and the user is the
 * authority on where a card sits — but the terminal/side states follow rules:
 *
 *   - any active state can be parked → Blocked or Cancelled;
 *   - Blocked un-parks back to any active state;
 *   - Cancelled / Done reopen only to a sensible re-entry point.
 *
 * Agent transitions (triage → discovery → questioner) go through the canonical
 * active-state edges and are therefore always valid under this graph.
 */
const ACTIVE: ReadonlySet<string> = new Set([
  "inbox",
  "triaged",
  "refining",
  "needs_feedback",
  "ready",
  "implementing",
  "verifying",
  "review",
]);

export function isValidStatus(status: string): boolean {
  return (TASK_STATUSES as readonly string[]).includes(status);
}

/** Whether a task may move from `from` to `to` under the lifecycle graph. */
export function canTransition(from: string, to: string): boolean {
  if (!isValidStatus(to)) return false;
  if (from === to) return true; // no-op is always allowed
  if (to === "blocked" || to === "cancelled") return true; // park from anywhere
  if (to === "done") return ACTIVE.has(from); // complete from any active state
  if (from === "cancelled") return to === "inbox" || to === "ready"; // reopen
  if (from === "done") return to === "ready" || to === "review"; // reopen
  if (from === "blocked") return ACTIVE.has(to); // un-park to any active state
  return ACTIVE.has(from) && ACTIVE.has(to); // free movement within the workflow
}

/** The statuses a task may legally move to from `from` (drives UI affordances). */
export function allowedTransitions(from: string): string[] {
  return (TASK_STATUSES as readonly string[]).filter((to) => to !== from && canTransition(from, to));
}
