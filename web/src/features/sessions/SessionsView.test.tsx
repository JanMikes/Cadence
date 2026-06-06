import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionsView } from "./SessionsView";

test("SessionsView renders live + tracked session sections", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SessionsView />
    </QueryClientProvider>,
  );
  expect(html).toContain("Sessions");
  expect(html).toContain("Live processes");
  expect(html).toContain("Cadence sessions");
});
