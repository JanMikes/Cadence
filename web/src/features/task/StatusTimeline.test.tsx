import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusTimeline } from "./StatusTimeline";

test("StatusTimeline renders nothing until events load", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <StatusTimeline taskId="t1" />
    </QueryClientProvider>,
  );
  // no timeline data on first synchronous render -> renders null
  expect(html).toBe("");
});
