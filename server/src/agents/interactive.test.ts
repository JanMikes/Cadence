import type { InteractiveAsk, QAQuestion } from "@cadence/shared";
import { expect, test } from "bun:test";
import { describeAsks, qaQuestionsFromAsks, roleNoun } from "./interactive";

function ask(input: unknown, tool = "AskUserQuestion"): InteractiveAsk {
  return { tool, toolUseId: "toolu_t", input };
}

test("qaQuestionsFromAsks maps AskUserQuestion payloads to Q&A cards", () => {
  const qs = qaQuestionsFromAsks(
    [
      ask({
        questions: [
          {
            question: "Where should it live?",
            header: "Placement",
            multiSelect: false,
            options: [{ label: "Detail", description: "ignored" }, { label: "Board" }],
          },
          { question: "Which areas?", multiSelect: true, options: ["a", "b"] },
          { question: "Anything else?" }, // no options → free text
        ],
      }),
    ],
    [],
  );
  expect(qs).toHaveLength(3);
  expect(qs[0]).toMatchObject({
    id: "ask1",
    type: "single_choice",
    text: "Where should it live?",
    options: ["Detail", "Board"],
    why: "Placement",
  });
  expect(qs[1]).toMatchObject({ type: "multi_choice", options: ["a", "b"] });
  expect(qs[2]).toMatchObject({ type: "text" });
});

test("qaQuestionsFromAsks never collides with existing question ids/ranks", () => {
  const existing: QAQuestion[] = [
    { id: "q1", rank: 1, type: "text", text: "old" },
    { id: "ask2", rank: 2, type: "text", text: "old2" },
  ];
  const qs = qaQuestionsFromAsks([ask({ questions: [{ question: "new?" }] })], existing);
  expect(qs).toHaveLength(1);
  expect(qs[0]?.id).not.toBe("q1");
  expect(qs[0]?.id).not.toBe("ask2");
  expect(qs[0]?.rank).toBeGreaterThan(2);
});

test("qaQuestionsFromAsks ignores non-question tools and junk payloads", () => {
  expect(qaQuestionsFromAsks([ask({ plan: "..." }, "ExitPlanMode")], [])).toHaveLength(0);
  expect(qaQuestionsFromAsks([ask(null)], [])).toHaveLength(0);
  expect(qaQuestionsFromAsks([ask({ questions: [{ question: "  " }] })], [])).toHaveLength(0);
});

test("describeAsks reads like a sentence for questions, plan handoffs, and unknown tools", () => {
  expect(describeAsks([ask({ questions: [{ question: "Where?" }] })])).toContain("asked: “Where?”");
  expect(describeAsks([ask({ plan: "p" }, "ExitPlanMode")])).toContain("interactive plan");
  expect(describeAsks([ask({}, "SomeFutureTool")])).toContain("SomeFutureTool");
});

test("roleNoun has human names with a safe fallback", () => {
  expect(roleNoun("planner")).toBe("the Planner");
  expect(roleNoun("discovery")).toBe("Discovery");
  expect(roleNoun("mystery")).toBe("the mystery agent");
});
