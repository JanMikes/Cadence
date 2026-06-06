import type { SubagentDef } from "@cadence/shared";

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
 * the parent context.
 */
export const AGENT_LIBRARY: Record<string, SubagentDef> = {
  explorer: {
    description: "Read-only codebase explorer; reads many files, returns a distilled summary.",
    prompt:
      "You are a read-only code explorer. Investigate the area you're asked about by reading and searching files. NEVER modify anything. Return a concise, structured summary: the key files, how the relevant code works, and only the most pertinent snippets — never raw file dumps.",
    tools: EXPLORE_TOOLS,
    model: HAIKU,
  },
  "dependency-mapper": {
    description: "Maps imports/exports and module dependencies around a target.",
    prompt:
      "You are a read-only dependency mapper. For the target the user names, trace its imports/exports and which modules depend on it. Return a compact dependency map (who imports what) and note any cycles. Do not modify files.",
    tools: EXPLORE_TOOLS,
    model: HAIKU,
  },
  "security-reviewer": {
    description: "Reviews a change or area for security issues (read-only).",
    prompt:
      "You are a read-only security reviewer. Examine the named change/area for security problems (injection, authz, secrets, unsafe deserialization, path traversal, SSRF). Report only concrete, high-confidence findings with file:line and a brief why. Do not modify files.",
    tools: REVIEW_TOOLS,
    model: SONNET,
  },
  "test-reviewer": {
    description: "Reviews test coverage and quality (read-only).",
    prompt:
      "You are a read-only test reviewer. Assess whether the change is adequately tested: missing cases, weak assertions, flakiness risks. Return a short, prioritized list with file:line. Do not modify files.",
    tools: REVIEW_TOOLS,
    model: SONNET,
  },
  "convention-reviewer": {
    description: "Checks adherence to the project's conventions and patterns (read-only).",
    prompt:
      "You are a read-only convention reviewer. Compare the change against the surrounding code's conventions (naming, structure, error handling, idioms, CLAUDE.md rules). Flag deviations concisely with file:line. Do not modify files.",
    tools: REVIEW_TOOLS,
    model: SONNET,
  },
  "smoke-tester": {
    description: "Runs the project's build/tests and reports pass/fail (used in execution phases).",
    prompt:
      "You run the project's build and tests, then report pass/fail with the key failing output. Run only build/test/lint commands — do not modify source files.",
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
