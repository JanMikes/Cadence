import type { FleetRunResult, FleetSubResult } from "@cadence/shared";
import type { Db } from "../db/client";
import { fleetMembers, getFleetById } from "../fleets";
import { readPlan, readSpec } from "../store/store";
import { claudePermissionMode } from "../sessions";
import { getTaskDetail, resolvePermissionMode, updateTask } from "../tasks";
import { provisionWorktreeAt } from "../worktree";
import { buildImplementerPrompt } from "./implementer";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

export interface FleetRunOutcome {
  ran: boolean;
  result?: FleetRunResult;
  reason?: string;
}

/**
 * Multi-repo execution (spec §4): a fleet-assigned task runs the Implementer
 * across each member project's repo — its own isolated worktree per repo — and
 * collects per-repo sub-results. Requires an approved plan (shared across repos).
 * `run` is injectable so tests use the mock. Advances → verifying if any repo ran.
 */
export async function runFleetImplementer(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<FleetRunOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false, reason: "task not found" };
  if (!task.fleetId) return { ran: false, reason: "task is not assigned to a fleet" };
  const plan = readPlan(taskId);
  if (!plan.approved) return { ran: false, reason: "plan not approved" };
  const fleet = getFleetById(db, task.fleetId);
  if (!fleet) return { ran: false, reason: "fleet not found" };

  const members = fleetMembers(db, fleet.slug);
  if (members.length === 0) return { ran: false, reason: "fleet has no member projects" };

  const claudeMode = claudePermissionMode(resolvePermissionMode(db, taskId));
  const prompt = buildImplementerPrompt({ title: task.title, body: task.body }, readSpec(taskId), plan);

  const results: FleetSubResult[] = [];
  for (const project of members) {
    if (!project.rootPath) {
      results.push(sub(project, "", null, false, "project has no rootPath", 0));
      continue;
    }
    // Fleet runs are inherently parallel multi-repo — they require worktree isolation.
    // A member that hasn't opted in is skipped with a visible reason (in-place would
    // need per-repo serialization and could collide with the user's checkout).
    if (!project.worktreesEnabled) {
      results.push(
        sub(
          project,
          project.rootPath,
          null,
          false,
          "worktrees disabled for this project — enable them in Project settings to include it in fleet runs",
          0,
        ),
      );
      continue;
    }
    let wt: { path: string; branch: string };
    try {
      wt = provisionWorktreeAt(project.rootPath, task);
    } catch (err) {
      results.push(sub(project, project.rootPath, null, false, (err as Error).message, 0));
      continue;
    }
    const res = await run({ cwd: wt.path, role: "implementer", prompt, permissionMode: claudeMode });
    results.push(
      sub(project, wt.path, wt.branch, !res.isError, res.isError ? "agent errored" : undefined, res.costUsd),
    );
  }

  if (results.some((r) => r.ran)) updateTask(db, taskId, { status: "verifying" });
  return { ran: true, result: { taskId, fleet: fleet.slug, results } };
}

function sub(
  project: { slug: string; name: string },
  cwd: string,
  branch: string | null,
  ran: boolean,
  reason: string | undefined,
  costUsd: number,
): FleetSubResult {
  const s: FleetSubResult = { projectSlug: project.slug, projectName: project.name, cwd, branch, ran, costUsd };
  if (reason) s.reason = reason;
  return s;
}
