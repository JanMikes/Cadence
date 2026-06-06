import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewPanel } from "./ReviewPanel";

test("ReviewPanel renders the Review header + actions before data loads", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReviewPanel taskId="t1" onChanged={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Review");
  expect(html).toContain("Merge → Done");
  expect(html).toContain("No diff to show.");
});
