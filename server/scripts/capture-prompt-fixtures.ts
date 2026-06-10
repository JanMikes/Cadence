/** One-shot: freeze the CURRENT prompt-builder outputs as fixtures (plan §6.3.a).
 *  Run BEFORE the registry refactor; the snapshot test then proves byte-identity. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeliveryPrompt } from "../src/agents/delivery";
import { buildDiscoveryPrompt } from "../src/agents/discovery";
import { buildImplementerPrompt } from "../src/agents/implementer";
import { AGENT_LIBRARY } from "../src/agents/library";
import { buildPlannerPrompt } from "../src/agents/planner";
import { buildQuestionerPrompt } from "../src/agents/questioner";
import { buildReflectorPrompt } from "../src/agents/reflector";
import { buildTriagePrompt } from "../src/agents/triage";
import { buildVerifierPrompt } from "../src/agents/verifier";
import { buildWorktreeCheckPrompt } from "../src/agents/worktree-check";

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

const snapshots: Record<string, string> = {
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
  "reflector:signals": buildReflectorPrompt(["accepted task.priority = P1", "edited task.deadline = 2026-01-01"]),
  "reflector:none": buildReflectorPrompt([]),
  "worktree_check:static": buildWorktreeCheckPrompt(),
  ...Object.fromEntries(
    Object.entries(AGENT_LIBRARY).map(([name, def]) => [`subagent:${name}`, def.prompt]),
  ),
};

const dir = join(import.meta.dir, "..", "src", "agents", "__fixtures__");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "prompt-snapshots.json"), `${JSON.stringify(snapshots, null, 2)}\n`);
console.log(`captured ${Object.keys(snapshots).length} snapshots`);
