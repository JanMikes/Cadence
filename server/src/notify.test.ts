import type { Task, WorktreeCheck } from "@cadence/shared";
import { expect, test } from "bun:test";
import { notifyOnTransition, notifyWorktreeCheck } from "./notify";
import type { WsHub } from "./ws";

function stubHub() {
  const sent: unknown[] = [];
  const hub = { broadcast: (m: unknown) => sent.push(m) } as unknown as WsHub;
  return { hub, sent };
}

const task = (status: string): Task =>
  ({ id: "t1", title: "Do the thing", status }) as Task;

test("notifies on entering needs_feedback, not when already there", () => {
  const { hub, sent } = stubHub();

  const p = notifyOnTransition(hub, "refining", task("needs_feedback"));
  expect(p?.kind).toBe("needs_feedback");
  expect(sent[0]).toMatchObject({
    type: "event",
    name: "notify",
    payload: { kind: "needs_feedback", taskId: "t1", message: "Do the thing" },
  });

  expect(notifyOnTransition(hub, "needs_feedback", task("needs_feedback"))).toBeNull();
});

test("notifies delivered on entering done", () => {
  const { hub } = stubHub();
  expect(notifyOnTransition(hub, "review", task("done"))?.kind).toBe("delivered");
  expect(notifyOnTransition(hub, "done", task("done"))).toBeNull();
  expect(notifyOnTransition(hub, "inbox", task("ready"))).toBeNull(); // no notify for plain moves
});

test("notifies on entering plan_review (plan ready) and review (ready to merge)", () => {
  const { hub } = stubHub();
  expect(notifyOnTransition(hub, "implementing", task("plan_review"))?.kind).toBe("plan_review");
  expect(notifyOnTransition(hub, "plan_review", task("plan_review"))).toBeNull();
  expect(notifyOnTransition(hub, "verifying", task("review"))?.kind).toBe("review");
  expect(notifyOnTransition(hub, "review", task("review"))).toBeNull();
});

test("notifyWorktreeCheck reports ready, blockers, and failure outcomes", () => {
  const { hub, sent } = stubHub();
  const check = (verdict: "ready" | "blockers", blockers: number): WorktreeCheck => ({
    verdict,
    summary: "s",
    blockers: Array.from({ length: blockers }, (_, i) => ({ title: `b${i}`, detail: "", severity: "low" })),
    recommendation: null,
    checkedAt: 1,
  });

  const ready = notifyWorktreeCheck(hub, "Acme", { ran: true, check: check("ready", 0) });
  expect(ready).toMatchObject({ kind: "info", message: "Acme: ready for worktrees" });

  const blocked = notifyWorktreeCheck(hub, "Acme", { ran: true, check: check("blockers", 2) });
  expect(blocked.message).toBe("Acme: 2 blockers found");
  expect(notifyWorktreeCheck(hub, "Acme", { ran: true, check: check("blockers", 1) }).message).toBe(
    "Acme: 1 blocker found",
  );

  const failed = notifyWorktreeCheck(hub, "Acme", { ran: false, reason: "not a git repo" });
  expect(failed).toMatchObject({ kind: "info", title: "Worktree check failed", message: "Acme: not a git repo" });

  expect(sent).toHaveLength(4); // every outcome was broadcast as a notify event
  expect(sent[0]).toMatchObject({ type: "event", name: "notify" });
});
