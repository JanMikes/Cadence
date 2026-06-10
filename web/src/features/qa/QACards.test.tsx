import type { QAChannel } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QACards } from "./QACards";

function render(status: string, channel?: QAChannel): string {
  const qc = new QueryClient();
  if (channel) qc.setQueryData(["task", "t1", "qa"], channel);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <QACards taskId="t1" status={status} />
    </QueryClientProvider>,
  );
}

const QUESTION = {
  id: "q1",
  rank: 1,
  type: "single_choice",
  text: "Which styling approach?",
  options: ["inline overrides", "typography plugin"],
};

test("QACards renders nothing until questions load (Needs-Feedback only)", () => {
  // no qa data on first synchronous render -> renders null
  expect(render("needs_feedback")).toBe("");
});

test("QACards shows the card while feedback is needed", () => {
  const html = render("needs_feedback", { questions: [QUESTION], answers: {} });
  expect(html).toContain("Needs your input");
  expect(html).toContain("Which styling approach?");
});

test("QACards stays visible in needs_feedback even when pre-answered (Submit still pending)", () => {
  const html = render("needs_feedback", {
    questions: [QUESTION],
    answers: { q1: "inline overrides" },
  });
  expect(html).toContain("Needs your input");
});

test("QACards hides answered questions once the task moved on (ready and beyond)", () => {
  const answered: QAChannel = { questions: [QUESTION], answers: { q1: "inline overrides" } };
  // answered + consumed by the Refiner → history, not a call to action
  expect(render("ready", answered)).toBe("");
  // executing / closed states never show the card, answered or not
  for (const status of ["plan_review", "implementing", "verifying", "review", "done", "cancelled"]) {
    expect(render(status, answered)).toBe("");
    expect(render(status, { questions: [QUESTION], answers: {} })).toBe("");
  }
});

test("QACards surfaces open questions in pre-execution states", () => {
  const open: QAChannel = { questions: [QUESTION], answers: {} };
  expect(render("refining", open)).toContain("Needs your input");
  expect(render("ready", open)).toContain("Needs your input");
});
