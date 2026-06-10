import type { Project } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewProjectModal, ProjectAgentPrompts, Projects, ProjectSettingsModal } from "./Projects";

const noop = () => {};

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
  lastUsedAt: null,
};

function render(node: React.ReactNode): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

test("Projects leads with the list and offers New project + Import as header actions", () => {
  const html = render(<Projects />);
  expect(html).toContain("Projects");
  expect(html).toContain("New project");
  expect(html).toContain("Import from Claude Code");
  expect(html).toContain("Click a project to change its settings");
  // The create form lives in a modal now — not inlined on the page.
  expect(html).not.toContain("Create project");
});

test("NewProjectModal renders the create form with name + rootPath", () => {
  const html = render(<NewProjectModal onClose={noop} />);
  expect(html).toContain("New project");
  expect(html).toContain("Project name");
  expect(html).toContain("rootPath");
  expect(html).toContain("Create project");
});

test("ProjectSettingsModal shows the project with General/Repository/Agent prompts tabs", () => {
  const html = render(<ProjectSettingsModal project={project} onClose={noop} />);
  expect(html).toContain("Acme");
  expect(html).toContain("acme"); // slug subtitle
  expect(html).toContain("General");
  expect(html).toContain("Repository");
  expect(html).toContain("Agent prompts");
  expect(html).toContain("Save changes");
  expect(html).toContain("Worktree readiness");
});

test("ProjectAgentPrompts explains the project layer composes with the global prompts", () => {
  const html = render(<ProjectAgentPrompts project={project} />);
  expect(html).toContain("Agent prompts (this project)");
  expect(html).toContain("appended to the global prompt"); // composes, never replaces
  expect(html).toContain("Additional instructions");
});
