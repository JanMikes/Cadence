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
  // focus is explicitly optional — committing the plan alone is a valid ritual
  expect(html).toContain("optional — the plan alone is enough to commit");
  // no digest data on first synchronous render -> the empty-plan hint shows
  expect(html).toContain("Nothing planned");
});

test("Today asks the capture check before committing, with an add-task escape hatch", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Today onOpen={() => {}} onAddTask={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Ready to commit?");
  expect(html).toContain("is everything today demands on this list");
  expect(html).toContain("Something’s missing — add a task");
  // empty plan -> commit is disabled, with the reason spelled out (no silent dead ends)
  expect(html).toContain("an empty plan isn’t a plan yet");
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
