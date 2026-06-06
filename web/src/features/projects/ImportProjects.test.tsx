import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportProjects } from "./ImportProjects";

test("ImportProjects renders the import-from-Claude section", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ImportProjects />
    </QueryClientProvider>,
  );
  expect(html).toContain("Import from Claude Code");
  expect(html).toContain("Rescan");
});
