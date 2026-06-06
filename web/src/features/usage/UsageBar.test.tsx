import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageBar } from "./UsageBar";

test("UsageBar renders nothing until usage data loads (no crash without a provider data)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <UsageBar />
    </QueryClientProvider>,
  );
  // No data yet on first synchronous render -> renders null (ambient, non-noisy).
  expect(html).toBe("");
});
