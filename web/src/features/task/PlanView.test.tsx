import type { TaskPlan } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { _resetActivity, _setActivity } from "../../lib/activity";
import { PlanView } from "./PlanView";

afterEach(() => {
  _resetActivity();
});

function render(status: string, plan?: TaskPlan): string {
  const qc = new QueryClient();
  if (plan) qc.setQueryData(["task", "t1", "plan"], plan);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PlanView taskId="t1" status={status} />
    </QueryClientProvider>,
  );
}

const EMPTY: TaskPlan = { steps: [], approved: false, notes: null };

test("PlanView renders nothing until the plan loads", () => {
  // no plan data on first synchronous render -> renders null
  expect(render("implementing")).toBe("");
});

test("PlanView shows Planning… only while a Planner run is verifiably alive", () => {
  _setActivity("t1", "planner");
  expect(render("implementing", EMPTY)).toContain("Planning…");
});

test("PlanView is honest when the Planner died: interrupted note, not an eternal Planning…", () => {
  // status says implementing but nothing is running (e.g. gateway restart killed
  // the planner) — the stale-card bug from the 2026-06-10 incident.
  const html = render("implementing", EMPTY);
  expect(html).not.toContain("Planning…");
  expect(html).toContain("Planner isn’t running");
});

test("PlanView hides an empty plan once the task is past planning (review/done)", () => {
  // A merged/reviewed task without a plan.md must not claim the Planner is running.
  expect(render("review", EMPTY)).toBe("");
  expect(render("done", EMPTY)).toBe("");
});

test("PlanView still renders written steps for review/done tasks", () => {
  const plan: TaskPlan = {
    steps: [{ title: "Add the route guard" }],
    approved: true,
    notes: null,
  };
  expect(render("done", plan)).toContain("Add the route guard");
});

test("PlanView offers Approve plan while the plan awaits approval", () => {
  const plan: TaskPlan = { steps: [{ title: "Step" }], approved: false, notes: null };
  expect(render("plan_review", plan)).toContain("Approve plan");
});

test("PlanView keeps an action for an approved plan parked back in Plan review (interrupted run)", () => {
  // The 2026-06-10 dead end: PLAY queued behind the project lock, the gateway
  // restarted, recovery moved the task implementing → plan_review — but the plan
  // was already approved, so the approve-gated button vanished and the user had
  // no way to run it. Plan review must ALWAYS be actionable.
  const plan: TaskPlan = { steps: [{ title: "Step" }], approved: true, notes: null };
  const html = render("plan_review", plan);
  expect(html).toContain("Run plan");
  expect(html).toContain("interrupted");
});

test("PlanView offers Revise plan (feedback → re-draft) only while in Plan review", () => {
  const plan: TaskPlan = { steps: [{ title: "Step" }], approved: false, notes: null };
  // Plan review: the second exit exists — approval is never the only way out.
  expect(render("plan_review", plan)).toContain("Revise plan");
  // Past the gate, the plan is reference material — no revise affordance.
  for (const status of ["implementing", "verifying", "review", "done"]) {
    expect(render(status, plan)).not.toContain("Revise plan");
  }
});

test("PlanView shows no run action for an approved plan that is actually executing", () => {
  const plan: TaskPlan = { steps: [{ title: "Step" }], approved: true, notes: null };
  for (const status of ["implementing", "verifying", "review", "done"]) {
    const html = render(status, plan);
    expect(html).not.toContain("Run plan");
    expect(html).not.toContain("Approve plan");
  }
});
