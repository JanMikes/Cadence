import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Calendar } from "./Calendar";

test("Calendar renders the heading + weekday labels", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Calendar onOpenTask={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Calendar");
  expect(html).toContain("Mon");
  expect(html).toContain("Sun");
});
