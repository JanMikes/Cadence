import type { SubagentDef } from "@cadence/shared";
import { expect, test } from "bun:test";
import { AGENT_LIBRARY, agentsJson, listAgents } from "./library";

const MUTATING = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

test("the library has explorers + reviewers, each with a description/prompt/tools", () => {
  const names = Object.keys(AGENT_LIBRARY);
  expect(names).toContain("explorer");
  expect(names).toContain("security-reviewer");
  expect(names).toContain("convention-reviewer");

  for (const a of listAgents()) {
    expect(a.description.length).toBeGreaterThan(0);
    expect(a.prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(a.tools)).toBe(true);
    expect(a.model).toBeTruthy();
  }
});

test("explorers and reviewers are read-only (no mutating tools)", () => {
  for (const name of ["explorer", "dependency-mapper", "security-reviewer", "test-reviewer", "convention-reviewer"]) {
    const tools = AGENT_LIBRARY[name]?.tools ?? [];
    expect(tools.some((t) => MUTATING.includes(t))).toBe(false);
  }
});

test("agentsJson serializes the whole library or a selected subset", () => {
  const all = JSON.parse(agentsJson()) as Record<string, SubagentDef>;
  expect(Object.keys(all)).toEqual(Object.keys(AGENT_LIBRARY));
  expect(all.explorer?.tools).toContain("Read");

  const subset = JSON.parse(agentsJson(["explorer", "nonexistent"])) as Record<string, SubagentDef>;
  expect(Object.keys(subset)).toEqual(["explorer"]); // unknown names ignored
  expect(subset.explorer?.description).toBeTruthy();
});
