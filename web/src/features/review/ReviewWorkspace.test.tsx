import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewFindings, TaskDetail } from "@cadence/shared";
import { findingsToMarkdown, ReviewWorkspace } from "./ReviewWorkspace";

function reviewTask(direction: "perform" | "address", status = "review"): TaskDetail {
  return {
    id: "t1",
    title: "Review widget",
    body: "",
    status,
    priority: null,
    projectId: null,
    fleetId: null,
    deadline: null,
    estimate: null,
    deliveryMode: null,
    permissionMode: null,
    prUrl: null,
    gitContext: null,
    taskType: "code_review",
    reviewDirection: direction,
    reviewRef: "https://github.com/acme/widget/pull/42",
    parentTaskId: null,
    createdAt: 1,
    updatedAt: 1,
    labels: [],
    titleGenerated: false,
    resolvedPermissionMode: "auto",
    resolvedDeliveryMode: "branch_summary",
    costUsd: 0,
  };
}

const FINDINGS: ReviewFindings = {
  summary: "One blocker.",
  verdictSuggestion: "request_changes",
  generatedAt: 1,
  findings: [
    { severity: "blocker", file: "x.ts", line: 3, title: "Races", body: "This races." },
    { severity: "nit", file: "y.ts", line: 9, title: "Naming", body: "Nit.", decision: "dismiss" },
  ],
};

test("perform pane renders severity chips, actions, verdict + explicit publish (§6.5.e)", () => {
  const qc = new QueryClient();
  qc.setQueryData(["review-findings", "t1"], FINDINGS);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={reviewTask("perform")} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Review workspace");
  expect(html).toContain("blocker");
  expect(html).toContain("x.ts:3");
  expect(html).toContain("Dismiss");
  expect(html).toContain("Publish review"); // explicit, armed confirm
  expect(html).toContain("Copy as Markdown");
  expect(html).toContain("Request changes");
});

test("address pane renders classification chips + approve/post actions (§6.5.f)", () => {
  const qc = new QueryClient();
  qc.setQueryData(["review-proposal", "t1"], {
    generatedAt: 1,
    overallNote: "One fix.",
    threads: [
      { threadId: "RT_1", classification: "must_fix", reply: "Fixed.", patch: "p", resolves: true },
      { threadId: "RT_2", classification: "pushback", reply: "Kept as-is.", resolves: false },
    ],
  });
  const planReview = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={reviewTask("address", "plan_review")} />
    </QueryClientProvider>,
  );
  expect(planReview).toContain("must fix");
  expect(planReview).toContain("push back");
  expect(planReview).toContain("Approve &amp; apply fixes");

  const review = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={reviewTask("address", "review")} />
    </QueryClientProvider>,
  );
  expect(review).toContain("Post replies &amp; resolve");
});

test("findingsToMarkdown includes only non-dismissed findings", () => {
  const md = findingsToMarkdown(FINDINGS);
  expect(md).toContain("Races");
  expect(md).not.toContain("Naming"); // dismissed
  expect(md).toContain("Verdict: request_changes");
});

test("standard tasks render no workspace at all", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={{ ...reviewTask("perform"), taskType: "standard" }} />
    </QueryClientProvider>,
  );
  expect(html).toBe("");
});

test("a closed perform task is a record, not a control panel", () => {
  const qc = new QueryClient();
  qc.setQueryData(["review-findings", "t1"], FINDINGS);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={reviewTask("perform", "done")} />
    </QueryClientProvider>,
  );
  // findings still visible as history, but no triage/publish controls
  expect(html).toContain("x.ts:3");
  expect(html).not.toContain("Dismiss");
  expect(html).not.toContain("Publish review");
  expect(html).toContain("never published");
  expect(html).toContain("Copy as Markdown"); // the record stays exportable
});

test("a closed task without artifacts never says “press PLAY”", () => {
  const qc = new QueryClient();
  qc.setQueryData(["review-findings", "t1"], null);
  qc.setQueryData(["review-proposal", "t1"], null);
  const perform = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={reviewTask("perform", "done")} />
    </QueryClientProvider>,
  );
  expect(perform).not.toContain("press PLAY");
  expect(perform).toContain("closed");

  const address = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={reviewTask("address", "cancelled")} />
    </QueryClientProvider>,
  );
  expect(address).not.toContain("press PLAY");
  expect(address).toContain("closed");
});

test("a closed address task hides thread actions", () => {
  const qc = new QueryClient();
  qc.setQueryData(["review-proposal", "t1"], {
    generatedAt: 1,
    overallNote: "One fix.",
    threads: [{ threadId: "RT_1", classification: "must_fix", reply: "Fixed.", resolves: true }],
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewWorkspace task={reviewTask("address", "done")} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Fixed."); // history stays readable
  expect(html).not.toContain("Skip");
  expect(html).not.toContain("Edit reply");
  expect(html).toContain("never posted");
});
