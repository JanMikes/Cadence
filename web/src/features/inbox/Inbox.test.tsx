import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Inbox } from "./Inbox";

test("Inbox renders a quick-capture input and a labeled Capture button", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Inbox onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Inbox");
  expect(html).toContain("Capture a task"); // input placeholder + aria-label
  expect(html).toContain("Capture"); // the labeled capture button
  expect(html).toContain("<input");
});
