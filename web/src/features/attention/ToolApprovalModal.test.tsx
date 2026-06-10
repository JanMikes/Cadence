import type { ApprovalRequest } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolApprovalModal } from "./ToolApprovalModal";

function render(req: ApprovalRequest): string {
  const qc = new QueryClient();
  qc.setQueryData(["approvals"], [req]);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToolApprovalModal approvalId={req.id} onResolved={() => {}} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

test("an AskUserQuestion request renders as an answerable question, not a raw tool dump", () => {
  const html = render({
    id: "a1",
    sessionId: null,
    taskId: "t1",
    toolName: "AskUserQuestion",
    createdAt: 1,
    role: "planner",
    input: {
      questions: [
        {
          question: "Where should the Cancel button live?",
          header: "Placement",
          multiSelect: false,
          options: [
            { label: "Task detail", description: "the modal" },
            { label: "Board card", description: "hover action" },
          ],
        },
      ],
    },
  });
  expect(html).toContain("An agent is asking you");
  expect(html).toContain("Where should the Cancel button live?");
  expect(html).toContain("Task detail");
  expect(html).toContain("Board card");
  expect(html).toContain("Send answers — continue the run");
  expect(html).toContain("Skip — let the agent decide");
  // never the generic approve/deny copy for a question
  expect(html).not.toContain("Tool action awaiting approval");
});

test("a generic tool request keeps the Manual-mode approve/deny gate", () => {
  const html = render({
    id: "a2",
    sessionId: null,
    taskId: null,
    toolName: "Bash",
    createdAt: 1,
    input: { command: "bun test" },
  });
  expect(html).toContain("Tool action awaiting approval");
  expect(html).toContain("Bash");
  expect(html).toContain("Approve");
  expect(html).toContain("Deny");
});
