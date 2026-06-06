import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Memory } from "./Memory";

test("Memory renders the heading + add-file form", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Memory />
    </QueryClientProvider>,
  );
  expect(html).toContain("Memory");
  expect(html).toContain("learned, hand-editable context");
  expect(html).toContain("New memory file");
});
