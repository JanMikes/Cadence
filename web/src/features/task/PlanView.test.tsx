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
