import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposalsPanel } from "./ProposalsPanel";

test("ProposalsPanel renders nothing until proposals load (no noise when none)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ProposalsPanel />
    </QueryClientProvider>,
  );
  expect(html).toBe("");
});
