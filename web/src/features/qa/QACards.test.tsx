import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QACards } from "./QACards";

test("QACards renders nothing until questions load (Needs-Feedback only)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <QACards taskId="t1" />
    </QueryClientProvider>,
  );
  // no qa data on first synchronous render -> renders null
  expect(html).toBe("");
});
