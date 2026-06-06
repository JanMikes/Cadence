import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Fleets } from "./Fleets";

test("Fleets renders the heading + new-fleet form", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Fleets />
    </QueryClientProvider>,
  );
  expect(html).toContain("Fleets");
  expect(html).toContain("New fleet");
  expect(html).toContain("Member projects");
});
