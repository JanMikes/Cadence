import type { PlanStep, TaskPlan } from "@cadence/shared";
import type { Db } from "../db/client";
import { withReadAccess } from "../project-locks";
import { readPlan, readSpec, writePlan } from "../store/store";
import { getTaskDetail, resolveTaskCwd } from "../tasks";
import { getAgentPrompt, renderTemplate } from "./prompts";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

/** The JSON the Planner returns (agent-prompts.md §4). */
export interface PlannerJson {
  steps?: Array<{ title?: string; detail?: string; files?: string[]; risky?: boolean }>;
  notes?: string | null;
}

export interface PlannerOutcome {
  ran: boolean;
  steps?: number;
  /** True when the run stopped on an interactive ask — the task is already parked in
   *  Needs-input with Q&A cards; callers must NOT treat it as a failed PLAY. */
  askedUser?: boolean;
}

export function buildPlannerPrompt(task: { title: string; body: string }, spec: string): string {
  return renderTemplate(getAgentPrompt("planner"), {
    title: task.title,
    bodyLine: task.body ? `TASK BODY: ${task.body}` : "",
    specBlock: spec.trim() ? `\nSPEC:\n${spec.trim()}` : "",
  });
}

/**
 * Normalize the agent's steps into clean PlanStep objects — crucially, omit
 * undefined optional keys so the YAML frontmatter dump never trips on them
 * (same guard as the Q&A normalizer).
 */
export function normalizeSteps(j: PlannerJson): PlanStep[] {
  return (j.steps ?? [])
    .map((s) => {
      const title = (s.title ?? "").trim();
      if (!title) return null;
      const step: PlanStep = { title };
      if (s.detail?.trim()) step.detail = s.detail.trim();
      if (Array.isArray(s.files) && s.files.length) step.files = s.files;
      if (s.risky) step.risky = true;
      return step;
    })
    .filter((s): s is PlanStep => s !== null);
}

/** Apply a parsed planner result: write plan.md (unapproved). */
export function applyPlan(taskId: string, j: PlannerJson): PlannerOutcome {
  const steps = normalizeSteps(j);
  const plan: TaskPlan = { steps, approved: false, notes: j.notes?.trim() ? j.notes.trim() : null };
  writePlan(taskId, plan);
  return { ran: true, steps: steps.length };
}

/** Mark a task's plan approved (the human gate before the Implementer runs in 3.4). */
export function approvePlan(taskId: string): TaskPlan {
  const plan = readPlan(taskId);
  const approved: TaskPlan = { ...plan, approved: true };
  writePlan(taskId, approved);
  return approved;
}

/**
 * Run the Planner on a task: a one-shot Opus agent in the task's cwd, read-only
 * (plan mode), turning the spec into an ordered plan. `run` is injectable so
 * tests use the mock (no real model). Does not change task status.
 */
export async function runPlanner(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<PlannerOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false };

  // Read lock: the plan must be drafted against the repo's base branch, not a
  // half-written in-place task branch — queued behind any in-place execution.
  const result = await withReadAccess(db, taskId, () =>
    run({
      cwd: resolveTaskCwd(db, taskId),
      taskId,
      role: "planner",
      prompt: buildPlannerPrompt({ title: task.title, body: task.body }, readSpec(taskId)),
      permissionMode: "plan",
    }),
  );

  const j = (result.json ?? null) as PlannerJson | null;
  if (!j || typeof j !== "object") {
    // No plan because the Planner stopped to ask (the recording wrapper already parked
    // the task in Needs-input with Q&A cards). Answers land on the context channel and
    // feed the next PLAY — report the handoff so the caller doesn't "recover" over it.
    if (result.asks?.length) return { ran: false, askedUser: true };
    return { ran: false };
  }
  return applyPlan(taskId, j);
}
