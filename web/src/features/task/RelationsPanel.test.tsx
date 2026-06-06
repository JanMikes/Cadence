import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RelationsPanel } from "./RelationsPanel";

test("RelationsPanel renders the relationships section with a blocker control", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <RelationsPanel taskId="t1" parentTaskId={null} onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Relationships");
  expect(html).toContain("Blocked by");
  expect(html).toContain("add blocker");
});
