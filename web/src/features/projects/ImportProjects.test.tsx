import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportProjects } from "./ImportProjects";

test("ImportProjects renders the discovery content (title comes from the modal)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ImportProjects />
    </QueryClientProvider>,
  );
  expect(html).toContain("Working directories Claude Code has seen");
  expect(html).toContain("Rescan");
});
