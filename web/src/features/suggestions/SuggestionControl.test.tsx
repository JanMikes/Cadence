import type { Suggestion } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SuggestionControl } from "./SuggestionControl";

const suggestion: Suggestion = {
  id: "s1",
  entityType: "task",
  entityId: "t1",
  field: "priority",
  value: "high",
  rationale: "Deadline is near",
  confidence: 0.8,
  status: "suggested",
  source: "triage",
  createdAt: Date.now(),
  resolvedAt: null,
};

test("SuggestionControl shows the field/value/rationale + Accept/Edit/Override/Dismiss", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SuggestionControl suggestion={suggestion} onResolved={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("priority");
  expect(html).toContain("high");
  expect(html).toContain("Deadline is near");
  expect(html).toContain("suggested"); // provenance badge
  expect(html).toContain("Accept");
  expect(html).toContain("Edit");
  expect(html).toContain("Override");
  expect(html).toContain("Dismiss");
});

test("a resolved suggestion hides the action buttons (shows provenance only)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SuggestionControl suggestion={{ ...suggestion, status: "confirmed" }} onResolved={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("confirmed");
  expect(html).not.toContain(">Accept<");
});
