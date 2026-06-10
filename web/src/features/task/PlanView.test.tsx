import type { TaskPlan } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanView } from "./PlanView";

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

test("PlanView shows the Planning… placeholder only while implementing", () => {
  expect(render("implementing", EMPTY)).toContain("Planning…");
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
