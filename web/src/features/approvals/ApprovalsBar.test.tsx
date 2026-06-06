import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalsBar } from "./ApprovalsBar";

test("ApprovalsBar renders nothing when there are no pending approvals", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ApprovalsBar />
    </QueryClientProvider>,
  );
  // no approvals data on first synchronous render -> renders null (no banner)
  expect(html).toBe("");
});
