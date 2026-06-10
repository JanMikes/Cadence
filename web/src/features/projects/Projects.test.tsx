import type { Project } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectAgentPrompts, Projects } from "./Projects";

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

test("ProjectAgentPrompts explains the project layer composes with the global prompts", () => {
  const project: Project = {
    id: "p1",
    name: "Acme",
    slug: "acme",
    color: null,
    rootPath: "/tmp/acme",
    gitRemote: null,
    forgeOverride: null,
    defaultModel: null,
    defaultPermissionMode: "auto",
    defaultDeliveryMode: "branch_summary",
    autonomy: null,
    worktreesEnabled: false,
    worktreeCheck: null,
    worktreeCheckRun: null,
    systemPrompt: null,
    agentPrompts: { discovery: "Prefer bun APIs." },
    notes: null,
    createdAt: 0,
  };
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ProjectAgentPrompts project={project} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Agent prompts (this project)");
  expect(html).toContain("appended to the global prompt"); // composes, never replaces
  expect(html).toContain("Additional instructions");
});
