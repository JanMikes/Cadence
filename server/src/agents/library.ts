import type { SubagentDef } from "@cadence/shared";
import { getAgentPrompt } from "./prompts";

// Read-only tool sets — in-session subagents read a lot but never mutate the repo
// (spec §7.2/§7.3). The smoke-tester is the one exception (it runs the build/tests).
const EXPLORE_TOOLS = ["Read", "Grep", "Glob", "LS"];
const REVIEW_TOOLS = ["Read", "Grep", "Glob"];
const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-6";

/**
 * Cadence's reusable subagent library (spec §7.3). Each is `{description, prompt,
 * tools, model}`, injected per phase at spawn via `--agents <json>` (session-scoped,
 * no repo pollution). They return distilled summaries — raw file dumps never enter
 * the parent context. Prompt TEXT lives in the editable registry (§6.3.a,
 * `subagent:<name>` keys); tools + model stay code-owned here.
 */
export const AGENT_LIBRARY: Record<string, SubagentDef> = {
  explorer: {
    description: "Read-only codebase explorer; reads many files, returns a distilled summary.",
    prompt: getAgentPrompt("subagent:explorer"),
    tools: EXPLORE_TOOLS,
    model: HAIKU,
  },
  "dependency-mapper": {
    description: "Maps imports/exports and module dependencies around a target.",
    prompt: getAgentPrompt("subagent:dependency-mapper"),
    tools: EXPLORE_TOOLS,
    model: HAIKU,
  },
  "security-reviewer": {
    description: "Reviews a change or area for security issues (read-only).",
    prompt: getAgentPrompt("subagent:security-reviewer"),
    tools: REVIEW_TOOLS,
    model: SONNET,
  },
  "test-reviewer": {
    description: "Reviews test coverage and quality (read-only).",
    prompt: getAgentPrompt("subagent:test-reviewer"),
    tools: REVIEW_TOOLS,
    model: SONNET,
  },
  "convention-reviewer": {
    description: "Checks adherence to the project's conventions and patterns (read-only).",
    prompt: getAgentPrompt("subagent:convention-reviewer"),
    tools: REVIEW_TOOLS,
    model: SONNET,
  },
  "smoke-tester": {
    description: "Runs the project's build/tests and reports pass/fail (used in execution phases).",
    prompt: getAgentPrompt("subagent:smoke-tester"),
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: SONNET,
  },
};

export interface NamedSubagent extends SubagentDef {
  name: string;
}

export function listAgents(): NamedSubagent[] {
  return Object.entries(AGENT_LIBRARY).map(([name, def]) => ({ name, ...def }));
}

/**
 * Serialize selected library agents to the `--agents` JSON (a name→def map). With
 * no `names`, includes the whole library; unknown names are ignored.
 */
export function agentsJson(names?: string[]): string {
  const entries = Object.entries(AGENT_LIBRARY).filter(([n]) => !names || names.includes(n));
  return JSON.stringify(Object.fromEntries(entries));
}
