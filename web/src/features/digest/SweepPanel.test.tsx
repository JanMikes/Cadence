import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SweepPanel } from "./SweepPanel";

test("SweepPanel renders nothing until findings load (no noise when clean)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SweepPanel onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toBe("");
});
