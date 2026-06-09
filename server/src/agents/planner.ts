import type { PlanStep, TaskPlan } from "@cadence/shared";
import type { Db } from "../db/client";
import { readPlan, readSpec, writePlan } from "../store/store";
import { getTaskDetail, resolveTaskCwd } from "../tasks";
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
}

export function buildPlannerPrompt(task: { title: string; body: string }, spec: string): string {
  return [
    "You are the Planner. Using the finalized spec, acceptance criteria, and all context layers,",
    "produce a concrete, ordered implementation plan: the steps, the files each step touches, the",
    "sequencing, and how each acceptance criterion will be satisfied. Surface any step that is risky",
    "or irreversible (set risky:true). DO NOT WRITE CODE — you are read-only (plan mode). Output JSON only.",
    "",
    "Respond with ONLY this JSON shape:",
    '{"steps":[{"title":"string","detail":"string","files":["path"],"risky":false}],"notes":"string|null"}',
    "",
    `TASK TITLE: ${task.title}`,
    task.body ? `TASK BODY: ${task.body}` : "",
    spec.trim() ? `\nSPEC:\n${spec.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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

  const result = await run({
    cwd: resolveTaskCwd(db, taskId),
    taskId,
    role: "planner",
    prompt: buildPlannerPrompt({ title: task.title, body: task.body }, readSpec(taskId)),
    permissionMode: "plan",
  });

  const j = (result.json ?? null) as PlannerJson | null;
  if (!j || typeof j !== "object") return { ran: false };
  return applyPlan(taskId, j);
}
