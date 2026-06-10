import type { AgentOverride } from "@cadence/shared";
import { readSettings } from "../store/store";

/**
 * The agent prompt registry (plan §6.3.a) — every pipeline stage's instructions as an
 * editable `{{var}}` text template, with code-computed variables documented per agent.
 * The defaults below are byte-faithful extractions of the previously hardcoded builders
 * (proven by `prompt-snapshots.test.ts` against frozen fixtures). 6.3.b layers user
 * overrides on top (Settings → Agents & Prompts); builders keep their signatures and
 * render through here.
 */

/** Default model per agent role (spec §7; overridable per agent in Settings, 6.3.b). */
export function modelForRole(role?: string): string | undefined {
  switch (role) {
    case "triage":
    case "delivery":
    case "reflector":
      return "claude-haiku-4-5";
    case "discovery":
    case "questioner":
    case "verifier":
    case "worktree_check":
      return "claude-sonnet-4-6";
    case "planner":
    case "implementer":
    case "reviewer":
    case "review_responder":
      return "claude-opus-4-8"; // review quality > token cost (6.5 locked decision #3)
    default:
      return undefined; // let claude pick its default
  }
}

export interface AgentPromptVariable {
  name: string;
  doc: string;
}

export interface AgentPromptDef {
  /** Registry key: the session role (stages) or `subagent:<name>` (library subagents). */
  role: string;
  kind: "stage" | "subagent";
  label: string;
  description: string;
  /** Default model for the run (stages: modelForRole; subagents: set in library.ts). */
  defaultModel?: string;
  variables: AgentPromptVariable[];
  defaultTemplate: string;
}

const VAR_GLOBAL = /\{\{(\w[\w-]*)\}\}/g;
const VAR_TEST = /\{\{\w[\w-]*\}\}/;

/**
 * Substitute `{{var}}` placeholders. A line that contains placeholders and renders to
 * nothing (after trim) is dropped entirely — that reproduces the builders' historical
 * `.filter(Boolean)` behavior for conditional whole-line fragments, while literal blank
 * lines a user adds to a template are kept verbatim.
 */
export function renderTemplate(template: string, vars: Record<string, string | undefined> = {}): string {
  const out: string[] = [];
  for (const line of template.split("\n")) {
    const hadVar = VAR_TEST.test(line);
    const rendered = line.replace(VAR_GLOBAL, (_, key: string) => vars[key] ?? "");
    if (hadVar && rendered.trim() === "") continue;
    out.push(rendered);
  }
  return out.join("\n");
}

/** The naming instruction triage + discovery add when a task was captured without a title. */
export const TITLE_NAMING_INSTRUCTION =
  'The task was captured without a title — also write a "title": a concise, specific name for the\n' +
  "task (max 60 chars, imperative mood, no trailing period). Always include it, even if insufficient.";

/** Shared doc strings for variables that several stages compute the same way. */
const TITLE_VAR = { name: "title", doc: "The task title." };
const TITLE_INSTRUCTION_VAR = {
  name: "titleInstruction",
  doc: "Naming instructions when the task was captured without a title; empty otherwise (line drops).",
};
const TITLE_FIELD_VAR = {
  name: "titleField",
  doc: '`"title":"string",` inside the JSON shape when a title is requested; empty otherwise.',
};

export const AGENT_PROMPTS: Record<string, AgentPromptDef> = {
  triage: {
    role: "triage",
    kind: "stage",
    label: "Triage",
    description: "Fast first pass on a captured task: route to a project, set priority/deadline/labels, restate the goal — or bail as insufficient.",
    defaultModel: modelForRole("triage"),
    variables: [
      TITLE_VAR,
      { name: "bodyLine", doc: "`TASK BODY: <body>` when the task has a description; empty otherwise (line drops)." },
      { name: "projects", doc: "Comma-separated known projects as `slug (Name)`, or `(none yet)`." },
      TITLE_INSTRUCTION_VAR,
      TITLE_FIELD_VAR,
    ],
    defaultTemplate: [
      "You are the Triage agent for a personal task platform. Given a raw, possibly-messy task the user",
      "dumped into their inbox, do a fast first pass. Do NOT explore code. Output JSON only.",
      "Decide: which known project this belongs to (or null); a priority (P0..P3); a deadline if one is",
      "implied (YYYY-MM-DD or null); 2-4 labels; and a one-line restatement of the goal.",
      'If too vague to even route or restate, set sufficiency:"insufficient" and say what you need.',
      "If the task is fundamentally a CODE REVIEW — it references a PR/MR to review, or review",
      'feedback to address on the user\'s own PR/MR — also set taskType:"code_review", reviewRef to',
      'the PR/MR URL (or null), and reviewDirection: "perform" (reviewing someone else\'s change) or',
      '"address" (fixing feedback on the user\'s own change). Otherwise OMIT these three fields.',
      "{{titleInstruction}}",
      "Known projects: {{projects}}.",
      "Respond with ONLY this JSON shape:",
      '{"sufficiency":"ok|insufficient","needFromUser":"string|null","restatement":"string",{{titleField}}',
      '"taskType":"standard|code_review","reviewDirection":"perform|address","reviewRef":"url|null",',
      '"projectSlug":"string|null","priority":"P0|P1|P2|P3","deadline":"YYYY-MM-DD|null","labels":["string"]}',
      "TASK TITLE: {{title}}",
      "{{bodyLine}}",
    ].join("\n"),
  },

  discovery: {
    role: "discovery",
    kind: "stage",
    label: "Discovery",
    description: "Explores the repo (read-only, with explorer subagents) and turns the task into an actionable spec with acceptance criteria and unknowns.",
    defaultModel: modelForRole("discovery"),
    variables: [
      TITLE_VAR,
      { name: "bodyLine", doc: "`TASK BODY: <body>` when the task has a description; empty otherwise (line drops)." },
      TITLE_INSTRUCTION_VAR,
      TITLE_FIELD_VAR,
    ],
    defaultTemplate: [
      "You are the Discovery agent. The task is assigned to a project whose working directory is your",
      "cwd. Explore the relevant code (READ-ONLY — you may delegate to the `explorer` and",
      "`dependency-mapper` subagents) and turn the task into an actionable spec. Produce: a crisp problem",
      "statement, scope (in/out), the files/areas likely affected, 1-3 approach options with a",
      "recommendation, risks, and CHECKABLE acceptance criteria. List any genuine unknowns that block a",
      "confident implementation. If still too vague to implement responsibly, set",
      'sufficiency:"insufficient" and state precisely what you need. Output JSON only.',
      "{{titleInstruction}}",
      "Respond with ONLY this JSON shape:",
      '{"sufficiency":"ok|insufficient","needFromUser":"string|null",{{titleField}}"spec":"markdown",',
      '"scope":{"in":["string"],"out":["string"]},"affectedFiles":["path"],',
      '"approaches":[{"name":"string","summary":"string","recommended":true}],',
      '"risks":["string"],"acceptanceCriteria":["string"],"unknowns":["string"]}',
      "TASK TITLE: {{title}}",
      "{{bodyLine}}",
    ].join("\n"),
  },

  questioner: {
    role: "questioner",
    kind: "stage",
    label: "Questioner",
    description: "Turns the spec's unknowns into the smallest set of ranked Q&A cards needed to unblock implementation.",
    defaultModel: modelForRole("questioner"),
    variables: [
      TITLE_VAR,
      { name: "specText", doc: "The discovery spec markdown, or `(no spec yet)`." },
    ],
    defaultTemplate: [
      "You are the Questioner agent. Given the Discovery spec (incl. its unknowns) and the task,",
      "write the SMALLEST set of high-leverage questions needed to unblock implementation — ranked,",
      "each with a type (text | single_choice | multi_choice | boolean) and options where useful, and a",
      "one-line 'why'. Never ask what the spec/context already answers. If one blocker overrides, ask",
      "only that. Output JSON only.",
      "",
      "Respond with ONLY this JSON shape:",
      '{"questions":[{"id":"q1","rank":1,"type":"single_choice","text":"string","options":["string"],"why":"string"}]}',
      "",
      "TASK: {{title}}",
      "",
      "SPEC:",
      "{{specText}}",
    ].join("\n"),
  },

  planner: {
    role: "planner",
    kind: "stage",
    label: "Planner",
    description: "Produces the ordered implementation plan (steps, files, risk flags) from the finalized spec — read-only, shown for approval.",
    defaultModel: modelForRole("planner"),
    variables: [
      TITLE_VAR,
      { name: "bodyLine", doc: "`TASK BODY: <body>` when the task has a description; empty otherwise (line drops)." },
      { name: "specBlock", doc: "Blank line + `SPEC:` + the spec when one exists; empty otherwise (line drops)." },
    ],
    defaultTemplate: [
      "You are the Planner. Using the finalized spec, acceptance criteria, and all context layers,",
      "produce a concrete, ordered implementation plan: the steps, the files each step touches, the",
      "sequencing, and how each acceptance criterion will be satisfied. Surface any step that is risky",
      "or irreversible (set risky:true). DO NOT WRITE CODE — you are read-only (plan mode). Output JSON only.",
      "Respond with ONLY this JSON shape:",
      '{"steps":[{"title":"string","detail":"string","files":["path"],"risky":false}],"notes":"string|null"}',
      "TASK TITLE: {{title}}",
      "{{bodyLine}}",
      "{{specBlock}}",
    ].join("\n"),
  },

  implementer: {
    role: "implementer",
    kind: "stage",
    label: "Implementer",
    description: "Executes the approved plan in the worktree (or the locked project dir) to satisfy every acceptance criterion.",
    defaultModel: modelForRole("implementer"),
    variables: [
      TITLE_VAR,
      { name: "detailsLine", doc: "`DETAILS: <body>` when the task has a description; empty otherwise (line drops)." },
      { name: "specBlock", doc: "Blank line + `SPEC:` + the spec when one exists; empty otherwise (line drops)." },
      { name: "steps", doc: "The approved plan as a numbered list (⚠️-flagged risky steps), or `(no steps)`." },
      { name: "plannerNotesBlock", doc: "Blank line + `PLANNER NOTES: …` when the plan has notes; empty otherwise (line drops)." },
      { name: "placement", doc: "Code-computed safety preamble: in-place guardrails vs. isolated-worktree framing. Not editable per run." },
    ],
    defaultTemplate: [
      "You are the Implementer. Execute the APPROVED plan below to satisfy every acceptance criterion.",
      "{{placement}}",
      "follow the project's conventions and the composed context, and keep diffs reviewable.",
      "If you hit a blocker that needs a decision, STOP and report it rather than guessing.",
      "TASK: {{title}}",
      "{{detailsLine}}",
      "{{specBlock}}",
      "APPROVED PLAN:",
      "{{steps}}",
      "{{plannerNotesBlock}}",
    ].join("\n"),
  },

  verifier: {
    role: "verifier",
    kind: "stage",
    label: "Verifier",
    description: "Independently checks the implementation against acceptance criteria: runs tests/build/lint and fans out reviewer subagents. Reports, never fixes.",
    defaultModel: modelForRole("verifier"),
    variables: [
      TITLE_VAR,
      { name: "detailsLine", doc: "`DETAILS: <body>` when the task has a description; empty otherwise (line drops)." },
      { name: "specBlock", doc: "Blank line + `SPEC:` + the spec when one exists; empty otherwise (line drops)." },
      { name: "planBlock", doc: "Blank line + `PLAN:` + numbered step titles when a plan exists; empty otherwise (line drops)." },
    ],
    defaultTemplate: [
      "You are the Verifier. Independently check the implementation in this worktree against the",
      "acceptance criteria. Run the project's tests/build/lint (delegate to the `smoke-tester` subagent)",
      "and review the diff for correctness and convention/security/test gaps (delegate to the",
      "`security-reviewer`, `test-reviewer`, and `convention-reviewer` subagents). Confirm each acceptance",
      "criterion is met. Report pass/fail with specifics — DO NOT FIX, only report. Output JSON only.",
      "Respond with ONLY this JSON shape:",
      '{"passed":false,"criteria":[{"criterion":"string","met":true,"evidence":"string"}],',
      '"checks":[{"name":"tests|build|lint","passed":true,"output":"string"}],',
      '"issues":[{"severity":"high|med|low","detail":"string","file":"path"}]}',
      "TASK: {{title}}",
      "{{detailsLine}}",
      "{{specBlock}}",
      "{{planBlock}}",
    ].join("\n"),
  },

  delivery: {
    role: "delivery",
    kind: "stage",
    label: "Delivery",
    description: "Writes the human summary of what changed and why; Cadence then finalizes the branch/PR deterministically.",
    defaultModel: modelForRole("delivery"),
    variables: [
      TITLE_VAR,
      { name: "detailsLine", doc: "`DETAILS: <body>` when the task has a description; empty otherwise (line drops)." },
      { name: "specBlock", doc: "Blank line + `SPEC:` + the spec when one exists; empty otherwise (line drops)." },
      { name: "checksLine", doc: "Blank line + `VERIFY CHECKS: ✅/❌ …` when verify results exist; empty otherwise (line drops)." },
    ],
    defaultTemplate: [
      "You are the Delivery agent. Produce a concise human summary of WHAT changed and WHY, referencing",
      "the acceptance criteria and the verify results. Be specific and skimmable. Output JSON only.",
      'Respond with ONLY this JSON shape: {"summary":"markdown","branch":"string|null","prUrl":"string|null"}',
      "TASK: {{title}}",
      "{{detailsLine}}",
      "{{specBlock}}",
      "{{checksLine}}",
    ].join("\n"),
  },

  reflector: {
    role: "reflector",
    kind: "stage",
    label: "Reflector",
    description: "Distills durable lessons from your Accept/Edit/Override decisions into Cadence's memory.",
    defaultModel: modelForRole("reflector"),
    variables: [
      { name: "signalsList", doc: "Recent suggestion decisions as `- …` lines; empty when there are none (line drops)." },
    ],
    defaultTemplate: [
      "You are the Reflector. Below are recent decisions I made on Cadence's suggestions (what I",
      "Accepted/Edited/Overrode/Dismissed). Distill only DURABLE, GENERAL lessons worth remembering —",
      "recurring patterns, not one-offs. Each lesson is one concise sentence. If nothing is durable,",
      "return an empty list. Output JSON only.",
      "",
      'Respond with ONLY: {"lessons":[{"scope":"global|<project-slug>","note":"string"}]}',
      "",
      "SIGNALS:",
      "{{signalsList}}",
    ].join("\n"),
  },

  worktree_check: {
    role: "worktree_check",
    kind: "stage",
    label: "Worktree readiness check",
    description: "Inspects a repo (read-only) for blockers to running tasks from a fresh git worktree; proposes the verdict.",
    defaultModel: modelForRole("worktree_check"),
    variables: [],
    defaultTemplate: [
      "You are checking whether THIS repository (your cwd) can run Claude Code tasks from a FRESH",
      "git worktree — a second checkout of the repo in a sibling directory, starting with only the",
      "committed files (no untracked files, no installed dependencies, no running services).",
      "",
      "Inspect the repo (READ-ONLY) and look for blockers, e.g.:",
      "- required files that are NOT committed (.env / .env.local, config/*.local, secrets, certs)",
      "- a dev setup that assumes one fixed checkout: docker-compose with host-port bindings or",
      "  bind-mounts of the repo path, databases/services bound to fixed ports, absolute paths in",
      "  config or scripts, symlinks out of the repo",
      "- heavy per-checkout setup: dependency install (node_modules, vendor, venv), code generation,",
      "  build caches — note the cost, it's a soft blocker",
      "- git submodules / git-lfs (worktrees need an extra init step)",
      "- README/docs setup steps that would not work from a second checkout",
      "",
      "Weigh severity honestly: 'high' = tasks would fail or corrupt state, 'medium' = needs manual",
      "setup per worktree, 'low' = minor friction. If the repo is essentially self-contained after a",
      "dependency install, verdict is 'ready' (mention the install in the summary).",
      "",
      "Respond with ONLY this JSON shape:",
      '{"verdict":"ready|blockers","summary":"one short paragraph","blockers":[{"title":"string","detail":"string","severity":"high|medium|low"}],"recommendation":"string|null"}',
    ].join("\n"),
  },

  reviewer: {
    role: "reviewer",
    kind: "stage",
    label: "Code reviewer",
    description:
      "Reviews a PR/MR (perform direction): reads the pre-fetched diff against the live repo, adversarially verifies every finding, and proposes severity-ranked comments + a verdict. Never publishes — you triage and publish from the Review Workspace.",
    defaultModel: modelForRole("reviewer"),
    variables: [
      { name: "prKind", doc: "`PR` or `MR`." },
      { name: "reviewRef", doc: "The PR/MR URL under review." },
      { name: "taskDescription", doc: "What the change is supposed to do (task body; may be empty — line drops)." },
      { name: "strictness", doc: "lenient | standard | strict (Settings → Review)." },
      { name: "prMeta", doc: "Pre-fetched PR/MR metadata block (title, author, branches, CI)." },
      { name: "prDiff", doc: "Pre-fetched full diff (capped for token economy)." },
      { name: "diffTruncatedNote", doc: "`, truncated` when the diff was capped; empty otherwise." },
    ],
    defaultTemplate: [
      "You are Cadence's code-review agent. Review the {{prKind}} {{reviewRef}} for this repository",
      "(your cwd IS the repo — explore it READ-ONLY for surrounding context).",
      "What this change is supposed to do (from the task; may be empty):",
      "{{taskDescription}}",
      "Strictness: {{strictness}} — lenient: blockers+majors only · standard: skip style nits a",
      "formatter would catch · strict: include minor issues and nits.",
      "PR/MR CONTEXT (pre-fetched):",
      "{{prMeta}}",
      "FULL DIFF (pre-fetched{{diffTruncatedNote}}):",
      "{{prDiff}}",
      "PROCESS",
      "1. Establish INTENT first: state in one line what the change claims to do. If you cannot tell",
      '   from the description + task context, that is itself a major finding ("unclear intent").',
      "2. Read the diff hunk-by-hunk — but NEVER judge a hunk in isolation: open the surrounding file",
      "   in the repo, the callers/callees of changed symbols, and related tests. The diff is the",
      "   question; the codebase is the context.",
      "3. Check, in priority order:",
      "   a. CORRECTNESS — does the implementation actually do what it claims? Edge cases, error",
      "      paths, async/races, off-by-ones, null/undefined, broken invariants.",
      "   b. REGRESSIONS — what existing behavior could this break? Search for every other",
      "      caller/usage of each changed symbol before concluding.",
      "   c. SECURITY — injection (SQL/shell/path/HTML), authn/authz gaps, secrets in code, unsafe",
      "      deserialization, SSRF, missing validation at trust boundaries.",
      "   d. CONVENTIONS — does it follow THIS codebase (naming, structure, error handling, test",
      "      patterns)? Cite an existing file as evidence; never impose outside style.",
      "   e. TESTS — are the claimed behaviors tested? Do the tests assert the right things (not",
      "      merely run)?",
      "4. ADVERSARIALLY VERIFY every candidate finding before reporting: reopen the code and try to",
      "   prove yourself wrong. Discard anything you cannot back with a concrete failure scenario or",
      "   cited evidence — false positives erode trust faster than missed nits.",
      "5. For each surviving finding, propose a concrete fix (include a patch when ≤ ~15 lines).",
      "Respond with ONLY this JSON shape:",
      '{"summary":"markdown","verdictSuggestion":"approve|comment|request_changes",',
      '"findings":[{"severity":"blocker|major|minor|nit","file":"path","line":1,"title":"string",',
      '"body":"string","evidence":"string","suggestedPatch":"string|null"}]}',
      "- body: plain language, reviewer-to-author tone — direct, kind, specific. Note genuinely good",
      "  patterns in the summary. Line numbers MUST anchor to the diff; never invent them.",
    ].join("\n"),
  },

  review_responder: {
    role: "review_responder",
    kind: "stage",
    label: "Review responder",
    description:
      "Addresses feedback on your own PR/MR (address direction): classifies every unresolved thread, proposes a fix and/or reply per thread — never blindly complies, never silently ignores. You approve before anything is applied or posted.",
    defaultModel: modelForRole("review_responder"),
    variables: [
      { name: "me", doc: "Your forge account login (the PR/MR author)." },
      { name: "prKind", doc: "`PR` or `MR`." },
      { name: "reviewRef", doc: "The PR/MR URL whose feedback is being addressed." },
      { name: "taskDescription", doc: "What the PR is meant to do (task body; may be empty — line drops)." },
      { name: "threadsJson", doc: "Pre-fetched unresolved review threads as JSON." },
    ],
    defaultTemplate: [
      "You are Cadence's review-response agent. {{me}} authored the {{prKind}} {{reviewRef}};",
      "reviewers left feedback. Propose how to address it (this repository is your cwd — READ-ONLY",
      "for now; a separate apply step makes the changes after approval).",
      "Unresolved threads (JSON): {{threadsJson}}",
      "Task context (what the PR is meant to do; may be empty): {{taskDescription}}",
      "PROCESS",
      "1. Read every thread fully — all comments AND the code at the anchored location (open the",
      "   file; don't trust the snippet).",
      "2. Classify each thread:",
      "   - must_fix — the reviewer is right; a code change is needed.",
      "   - question — answer it; no code change.",
      "   - preference — cheap to satisfy → just do it; expensive → explain the trade-off.",
      "   - pushback — the reviewer is mistaken or the change would harm the code; say why, with",
      "     evidence. NEVER blindly comply — evaluate each comment on the merits. NEVER silently",
      "     ignore one either — every thread gets a response.",
      "3. Group related threads into one coherent change where natural; note the grouping.",
      "4. For code changes: propose minimal, focused patches consistent with the branch's existing",
      "   approach.",
      '5. Draft a reply per thread: ≤3 sentences, specific ("done in <sha>", "kept as-is because …"),',
      "   no groveling, no defensiveness.",
      "Respond with ONLY this JSON shape:",
      '{"threads":[{"threadId":"string","classification":"must_fix|question|preference|pushback",',
      '"reply":"string","patch":"string|null","resolves":true}],"overallNote":"string"}',
      "You PROPOSE; the user approves replies and changes before anything is applied or posted.",
    ].join("\n"),
  },

  "subagent:explorer": {
    role: "subagent:explorer",
    kind: "subagent",
    label: "Explorer (subagent)",
    description: "Read-only codebase explorer; reads many files, returns a distilled summary.",
    variables: [],
    defaultTemplate:
      "You are a read-only code explorer. Investigate the area you're asked about by reading and searching files. NEVER modify anything. Return a concise, structured summary: the key files, how the relevant code works, and only the most pertinent snippets — never raw file dumps.",
  },
  "subagent:dependency-mapper": {
    role: "subagent:dependency-mapper",
    kind: "subagent",
    label: "Dependency mapper (subagent)",
    description: "Maps imports/exports and module dependencies around a target.",
    variables: [],
    defaultTemplate:
      "You are a read-only dependency mapper. For the target the user names, trace its imports/exports and which modules depend on it. Return a compact dependency map (who imports what) and note any cycles. Do not modify files.",
  },
  "subagent:security-reviewer": {
    role: "subagent:security-reviewer",
    kind: "subagent",
    label: "Security reviewer (subagent)",
    description: "Reviews a change or area for security issues (read-only).",
    variables: [],
    defaultTemplate:
      "You are a read-only security reviewer. Examine the named change/area for security problems (injection, authz, secrets, unsafe deserialization, path traversal, SSRF). Report only concrete, high-confidence findings with file:line and a brief why. Do not modify files.",
  },
  "subagent:test-reviewer": {
    role: "subagent:test-reviewer",
    kind: "subagent",
    label: "Test reviewer (subagent)",
    description: "Reviews test coverage and quality (read-only).",
    variables: [],
    defaultTemplate:
      "You are a read-only test reviewer. Assess whether the change is adequately tested: missing cases, weak assertions, flakiness risks. Return a short, prioritized list with file:line. Do not modify files.",
  },
  "subagent:convention-reviewer": {
    role: "subagent:convention-reviewer",
    kind: "subagent",
    label: "Convention reviewer (subagent)",
    description: "Checks adherence to the project's conventions and patterns (read-only).",
    variables: [],
    defaultTemplate:
      "You are a read-only convention reviewer. Compare the change against the surrounding code's conventions (naming, structure, error handling, idioms, CLAUDE.md rules). Flag deviations concisely with file:line. Do not modify files.",
  },
  "subagent:smoke-tester": {
    role: "subagent:smoke-tester",
    kind: "subagent",
    label: "Smoke tester (subagent)",
    description: "Runs the project's build/tests and reports pass/fail (used in execution phases).",
    variables: [],
    defaultTemplate:
      "You run the project's build and tests, then report pass/fail with the key failing output. Run only build/test/lint commands — do not modify source files.",
  },
};

/** The user's override for a role, if any (settings.agents, §6.3.b). */
export function getAgentOverride(role: string): AgentOverride | undefined {
  try {
    return readSettings().agents?.[role];
  } catch {
    return undefined; // unreadable settings must never break a spawn
  }
}

/**
 * The template for a role — the user's override when one is set (6.3.b), else the
 * default above. Unknown roles render as an empty template (defensive).
 */
export function getAgentPrompt(role: string): string {
  const custom = getAgentOverride(role)?.prompt?.trim();
  return custom || (AGENT_PROMPTS[role]?.defaultTemplate ?? "");
}

/** The model for a role's runs — override ?? registry default ?? role mapping. */
export function getAgentModel(role?: string): string | undefined {
  if (!role) return undefined;
  const custom = getAgentOverride(role)?.model?.trim();
  return custom || AGENT_PROMPTS[role]?.defaultModel || modelForRole(role);
}
