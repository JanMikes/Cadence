import type { TaskPlan } from "@cadence/shared";
import type { Db } from "../db/client";
import { claudePermissionMode } from "../sessions";
import { readPlan, readSpec } from "../store/store";
import { getTaskDetail, resolvePermissionMode, updateTask } from "../tasks";
import { beginInPlaceExecution, type ExecutionTarget, taskWorkEvidence } from "../worktree";
import { getAgentPrompt, renderTemplate } from "./prompts";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

export interface ImplementerOutcome {
  ran: boolean;
  status?: string;
  reason?: string;
  branch?: string;
  worktreePath?: string;
  costUsd?: number;
  /** True when the run stopped on an interactive ask — the task is already parked in
   *  Needs-input with Q&A cards; callers must not revert it to Ready. */
  askedUser?: boolean;
}

export function buildImplementerPrompt(
  task: { title: string; body: string },
  spec: string,
  plan: TaskPlan,
  where: { inPlace: boolean; branch: string | null } = { inPlace: false, branch: null },
): string {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. ${s.risky ? "⚠️ " : ""}${s.title}${s.detail ? ` — ${s.detail}` : ""}`)
    .join("\n");
  // The placement preamble stays code-computed (it's the in-place safety guardrail,
  // branch-dependent) — the editable template sequences it via {{placement}}.
  const placement = where.inPlace
    ? [
        `You are working DIRECTLY in the project's working copy${where.branch ? ` on the dedicated branch ${where.branch}` : ""} —`,
        "this is the user's real checkout, not a disposable sandbox. Stay strictly inside this repo,",
        "never run destructive commands (reset --hard, clean -fd, rm -rf), never switch branches,",
        "and never touch files unrelated to the plan. Make focused commits with clear messages,",
      ].join("\n")
    : [
        "You are in an isolated git worktree/branch for this task — make focused commits with clear",
        "messages,",
      ].join("\n");
  return renderTemplate(getAgentPrompt("implementer"), {
    title: task.title,
    detailsLine: task.body ? `DETAILS: ${task.body}` : "",
    specBlock: spec.trim() ? `\nSPEC:\n${spec.trim()}` : "",
    steps: steps || "(no steps)",
    plannerNotesBlock: plan.notes ? `\nPLANNER NOTES: ${plan.notes}` : "",
    placement,
  });
}

/**
 * Run the Implementer for a task (spec §7.5): require an approved plan, prepare the
 * execution target — the isolated worktree (3.3) when the project opted in, else the
 * project working dir on the task branch (in-place; the API chain holds the project
 * write lock and beginInPlaceExecution refuses a dirty tree) — run a one-shot Opus
 * agent THERE, then advance implementing → verifying. Inside the disposable worktree
 * the agent gets full tool access (bypassPermissions) so it can edit + commit + build
 * + test without stalling on a permission-gated command — a one-shot has no
 * interactive approval channel, and the sandbox plus the plan-approval and
 * review/merge gates are the safety boundary. In-place execution keeps the safer
 * resolved mode (never bypass the main tree). `run` is injectable so tests use the
 * mock. Bails gracefully (never throws) when the plan isn't approved or the target
 * can't be prepared.
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

  let target: ExecutionTarget;
  try {
    // Provisions the worktree, or (in-place) guards the dirty tree, snapshots
    // untracked paths, and checks out the task branch. Idempotent on re-entry.
    target = beginInPlaceExecution(db, taskId);
  } catch (err) {
    return { ran: false, reason: (err as Error).message };
  }

  let claudeMode = claudePermissionMode(resolvePermissionMode(db, taskId));
  // Dangerous-mode guardrail (§9): bypassPermissions is only allowed inside an
  // isolated worktree, never in-place on the main tree — a runaway can't escape.
  if (claudeMode === "bypassPermissions" && !target.worktreePath) {
    return {
      ran: false,
      reason: "Dangerous mode requires an isolated worktree — enable worktrees for this project",
    };
  }
  // In the isolated, disposable worktree, grant the one-shot Implementer full tool access so it can
  // edit + commit + build + test without stalling on a permission-gated `git` (acceptEdits gates
  // Bash, and a one-shot agent has nobody to ask). The sandbox + the plan-approval and review/merge
  // gates are the safety boundary. In-place execution (no worktree) keeps the safer resolved mode.
  if (target.worktreePath) claudeMode = "bypassPermissions";
  const result = await run({
    cwd: target.cwd,
    taskId,
    role: "implementer",
    prompt: buildImplementerPrompt({ title: task.title, body: task.body }, readSpec(taskId), plan, {
      inPlace: target.inPlace,
      branch: target.branch,
    }),
    permissionMode: claudeMode,
  });

  // Stopped to ask for human input AND the recording wrapper parked the task
  // (Q&A + Needs-input). Hand back a marker, not a failure.
  if (result.askParked) {
    return {
      ran: false,
      askedUser: true,
      branch: target.branch ?? undefined,
      worktreePath: target.worktreePath ?? undefined,
      costUsd: result.costUsd,
    };
  }

  if (result.isError) {
    return {
      ran: false,
      reason: `implementer agent errored${result.errorDetail ? ` — ${result.errorDetail}` : ""}`,
      branch: target.branch ?? undefined,
      worktreePath: target.worktreePath ?? undefined,
    };
  }

  // Work-product gate: an agent that "succeeded" without changing anything must not
  // advance — verifying nothing and reviewing nothing only fabricates a Done later.
  // (An early bail — "too vague", "nothing to do" — is a legitimate agent outcome,
  // but it belongs back with the human, not in the pipeline.)
  const evidence = taskWorkEvidence(db, taskId);
  if (evidence.attributable && !evidence.hasWork) {
    return {
      ran: false,
      reason: `the implementer finished without delivering any changes (${evidence.detail})`,
      branch: target.branch ?? undefined,
      worktreePath: target.worktreePath ?? undefined,
      costUsd: result.costUsd,
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
