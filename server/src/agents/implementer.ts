import type { TaskPlan } from "@cadence/shared";
import type { Db } from "../db/client";
import { claudePermissionMode } from "../sessions";
import { readPlan, readSpec } from "../store/store";
import { getTaskDetail, resolvePermissionMode, updateTask } from "../tasks";
import { resolveExecutionCwd } from "../worktree";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

export interface ImplementerOutcome {
  ran: boolean;
  status?: string;
  reason?: string;
  branch?: string;
  worktreePath?: string;
  costUsd?: number;
}

export function buildImplementerPrompt(
  task: { title: string; body: string },
  spec: string,
  plan: TaskPlan,
): string {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. ${s.risky ? "⚠️ " : ""}${s.title}${s.detail ? ` — ${s.detail}` : ""}`)
    .join("\n");
  return [
    "You are the Implementer. Execute the APPROVED plan below to satisfy every acceptance criterion.",
    "You are in an isolated git worktree/branch for this task — make focused commits with clear",
    "messages, follow the project's conventions and the composed context, and keep diffs reviewable.",
    "If you hit a blocker that needs a decision, STOP and report it rather than guessing.",
    "",
    `TASK: ${task.title}`,
    task.body ? `DETAILS: ${task.body}` : "",
    spec.trim() ? `\nSPEC:\n${spec.trim()}` : "",
    "",
    "APPROVED PLAN:",
    steps || "(no steps)",
    plan.notes ? `\nPLANNER NOTES: ${plan.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Run the Implementer for a task (spec §7.5): require an approved plan, provision
 * the isolated worktree (3.3), run a one-shot Opus agent THERE, then advance
 * implementing → verifying. Inside the disposable worktree the agent gets full tool
 * access (bypassPermissions) so it can edit + commit + build + test without stalling
 * on a permission-gated command — a one-shot has no interactive approval channel, and
 * the sandbox plus the plan-approval and review/merge gates are the safety boundary.
 * apply_in_place keeps the safer resolved mode (never bypass the main tree). `run` is
 * injectable so tests use the mock. Bails gracefully (never throws) when the plan
 * isn't approved or a worktree can't be provisioned.
 */
export async function runImplementer(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<ImplementerOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false, reason: "task not found" };

  const plan = readPlan(taskId);
  if (!plan.approved) return { ran: false, reason: "plan not approved" };

  let target: { cwd: string; branch: string | null; worktreePath: string | null };
  try {
    target = resolveExecutionCwd(db, taskId);
  } catch (err) {
    return { ran: false, reason: (err as Error).message };
  }

  let claudeMode = claudePermissionMode(resolvePermissionMode(db, taskId));
  // Dangerous-mode guardrail (§9): bypassPermissions is only allowed inside an
  // isolated worktree, never in-place on the main tree — a runaway can't escape.
  if (claudeMode === "bypassPermissions" && !target.worktreePath) {
    return { ran: false, reason: "Dangerous mode requires an isolated worktree (not apply_in_place)" };
  }
  // In the isolated, disposable worktree, grant the one-shot Implementer full tool access so it can
  // edit + commit + build + test without stalling on a permission-gated `git` (acceptEdits gates
  // Bash, and a one-shot agent has nobody to ask). The sandbox + the plan-approval and review/merge
  // gates are the safety boundary. apply_in_place (no worktree) keeps the safer resolved mode.
  if (target.worktreePath) claudeMode = "bypassPermissions";
  const result = await run({
    cwd: target.cwd,
    taskId,
    role: "implementer",
    prompt: buildImplementerPrompt({ title: task.title, body: task.body }, readSpec(taskId), plan),
    permissionMode: claudeMode,
  });

  if (result.isError) {
    return {
      ran: false,
      reason: "implementer agent errored",
      branch: target.branch ?? undefined,
      worktreePath: target.worktreePath ?? undefined,
    };
  }

  // Implemented → hand off to the Verifier (3.5).
  updateTask(db, taskId, { status: "verifying" });
  return {
    ran: true,
    status: "verifying",
    branch: target.branch ?? undefined,
    worktreePath: target.worktreePath ?? undefined,
    costUsd: result.costUsd,
  };
}
