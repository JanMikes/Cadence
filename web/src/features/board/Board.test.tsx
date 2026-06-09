import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Board } from "./Board";

test("Board renders lifecycle columns with plain-language labels", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Board");
  expect(html).toContain("Inbox");
  expect(html).toContain("Ready");
  expect(html).toContain("Needs input"); // plain language for needs_feedback
  expect(html).toContain("Plan review"); // waiting-for-you ≠ actively working (plan_review)
  expect(html).toContain("In progress"); // plain language for implementing
  expect(html).toContain("Done");
});

test("Board columns carry a per-stage accent (rainbow border-top)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("border-t-2"); // every column gets a colored top edge…
  expect(html).toContain("border-t-amber-400/80"); // …needs_feedback pinned amber
  expect(html).toContain("border-t-violet-400/80"); // …plan_review pinned violet
  expect(html).toContain("border-t-emerald-400/80"); // …done emerald
});

test("Board shows the project filter: checkboxes, No-project, and All-projects default", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Projects:");
  expect(html).toContain("No project"); // tasks without a project are filterable too
  expect(html).toContain("All projects"); // nothing checked (initial state) = show everything
  expect(html).toContain('type="checkbox"');
  expect(html).not.toContain(">Clear<"); // Clear only appears once a filter is active
});
