import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Projects } from "./Projects";

test("Projects renders a create form with name + rootPath + system prompt", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Projects />
    </QueryClientProvider>,
  );
  expect(html).toContain("Projects");
  expect(html).toContain("New project");
  expect(html).toContain("Project name");
  expect(html).toContain("rootPath");
  expect(html).toContain("Create project");
});
