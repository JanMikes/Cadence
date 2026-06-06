import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "./Analytics";

test("Analytics renders the heading + intro before data loads", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Analytics />
    </QueryClientProvider>,
  );
  expect(html).toContain("Analytics");
  expect(html).toContain("effort cost");
});
