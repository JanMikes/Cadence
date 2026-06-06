import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanView } from "./PlanView";

test("PlanView renders nothing until the plan loads", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PlanView taskId="t1" />
    </QueryClientProvider>,
  );
  // no plan data on first synchronous render -> renders null
  expect(html).toBe("");
});
