import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Board } from "./Board";

test("Board renders lifecycle columns with plain-language labels", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Board");
  expect(html).toContain("Inbox");
  expect(html).toContain("Ready");
  expect(html).toContain("Needs input"); // plain language for needs_feedback
  expect(html).toContain("In progress"); // plain language for implementing
  expect(html).toContain("Done");
});
