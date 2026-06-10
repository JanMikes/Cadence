import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Today } from "./Today";

test("Today renders the planning ritual heading + goal prompt", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Today onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Today");
  expect(html).toContain("What matters most today?");
  // no digest data on first synchronous render -> the empty-plan hint shows
  expect(html).toContain("Nothing planned");
});

test("Today explains the ritual with a Plan → Commit → Recap stepper", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Today onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("1 · Plan");
  expect(html).toContain("2 · Commit");
  expect(html).toContain("3 · Recap");
  expect(html).toContain("you are here"); // active step is marked (planning by default)
  expect(html).toContain("Proposed automatically from your open tasks");
});
