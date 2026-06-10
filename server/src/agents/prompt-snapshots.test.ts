import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeliveryPrompt } from "./delivery";
import { buildDiscoveryPrompt } from "./discovery";
import { buildImplementerPrompt } from "./implementer";
import { AGENT_LIBRARY } from "./library";
import { buildPlannerPrompt } from "./planner";
import { AGENT_PROMPTS, renderTemplate } from "./prompts";
import { buildQuestionerPrompt } from "./questioner";
import { buildReflectorPrompt } from "./reflector";
import { buildTriagePrompt } from "./triage";
import { buildVerifierPrompt } from "./verifier";
import { buildWorktreeCheckPrompt } from "./worktree-check";

/**
 * §6.3.a byte-identity proof: the registry-rendered prompts must equal the frozen
 * outputs of the previously hardcoded builders (captured BEFORE the refactor by
 * `server/scripts/capture-prompt-fixtures.ts` — same inputs below, verbatim).
 */
const SNAPSHOTS = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__", "prompt-snapshots.json"), "utf8"),
) as Record<string, string>;

const task = { title: "Fix the flaky login test", body: "It fails on CI only.\nSee run #42." };
const bare = { title: "Fix the flaky login test", body: "" };
const projects = [
  { slug: "acme-app", name: "Acme App" },
  { slug: "tools", name: "Internal Tools" },
];
const spec = "# Spec\nMake login deterministic.\n\n## Acceptance criteria\n- [ ] test passes 10x";
const plan = {
  steps: [
    { title: "Stabilize the clock", detail: "freeze timers", files: ["login.ts"], risky: false },
    { title: "Delete the retry hack", risky: true },
  ],
  approved: true,
  notes: "Watch the session fixture.",
};
const emptyPlan = { steps: [], approved: true, notes: null };
const verify = {
  passed: true,
  criteria: [],
  checks: [
    { name: "tests", passed: true },
    { name: "build", passed: false },
  ],
  issues: [],
};

const RENDERED: Record<string, string> = {
  "triage:full": buildTriagePrompt(task, projects, { titleNeeded: false }),
  "triage:titleNeeded-bare": buildTriagePrompt(bare, [], { titleNeeded: true }),
  "discovery:full": buildDiscoveryPrompt(task, { titleNeeded: false }),
  "discovery:titleNeeded-bare": buildDiscoveryPrompt(bare, { titleNeeded: true }),
  "questioner:spec": buildQuestionerPrompt(spec, task),
  "questioner:nospec": buildQuestionerPrompt("", task),
  "planner:full": buildPlannerPrompt(task, spec),
  "planner:bare": buildPlannerPrompt(bare, ""),
  "implementer:worktree": buildImplementerPrompt(task, spec, plan, { inPlace: false, branch: null }),
  "implementer:inplace-branch": buildImplementerPrompt(task, spec, plan, {
    inPlace: true,
    branch: "cadence/fix-login",
  }),
  "implementer:inplace-nobranch-empty": buildImplementerPrompt(bare, "", emptyPlan, {
    inPlace: true,
    branch: null,
  }),
  "verifier:full": buildVerifierPrompt(task, spec, plan),
  "verifier:bare": buildVerifierPrompt(bare, "", emptyPlan),
  "delivery:full": buildDeliveryPrompt(task, spec, verify),
  "delivery:bare": buildDeliveryPrompt(bare, "", null),
  "reflector:signals": buildReflectorPrompt([
    "accepted task.priority = P1",
    "edited task.deadline = 2026-01-01",
  ]),
  "reflector:none": buildReflectorPrompt([]),
  "worktree_check:static": buildWorktreeCheckPrompt(),
  ...Object.fromEntries(
    Object.entries(AGENT_LIBRARY).map(([name, def]) => [`subagent:${name}`, def.prompt]),
  ),
};

for (const [key, frozen] of Object.entries(SNAPSHOTS)) {
  test(`prompt registry is byte-identical to the pre-refactor builder: ${key}`, () => {
    expect(RENDERED[key]).toBe(frozen);
  });
}

test("every fixture variant is still rendered (no snapshot silently dropped)", () => {
  expect(Object.keys(RENDERED).sort()).toEqual(Object.keys(SNAPSHOTS).sort());
});

test("renderTemplate: drops var-only empty lines, keeps literal blanks, ignores unknown vars", () => {
  const tpl = "head\n{{gone}}\n\nkeep {{x}}\n{{multi}}";
  expect(renderTemplate(tpl, { x: "me", multi: "a\nb", gone: "" })).toBe("head\n\nkeep me\na\nb");
});

test("registry: every stage def carries label, description and documented variables", () => {
  for (const def of Object.values(AGENT_PROMPTS)) {
    expect(def.label.length).toBeGreaterThan(0);
    expect(def.description.length).toBeGreaterThan(0);
    // every {{var}} used in the template is documented (placement etc. included)
    for (const m of def.defaultTemplate.matchAll(/\{\{(\w[\w-]*)\}\}/g)) {
      expect(def.variables.map((v) => v.name)).toContain(m[1] as string);
    }
  }
});
