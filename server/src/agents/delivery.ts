import type { DeliveryResult, VerifyReport } from "@cadence/shared";
import type { Db } from "../db/client";
import { appendContext, readSpec, readVerify, writeDelivery } from "../store/store";
import { getTaskDetail, resolveDeliveryMode } from "../tasks";
import {
  branchName,
  commitInPlaceChanges,
  type ExecutionTarget,
  finalizeInPlaceExecution,
  resolveExecutionCwd,
} from "../worktree";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

/** The JSON the Delivery agent returns (agent-prompts.md §7). */
export interface DeliveryJson {
  summary?: string;
  branch?: string | null;
  prUrl?: string | null;
}

export interface DeliveryOutcome {
  ran: boolean;
  mode?: string;
  branch?: string | null;
  prUrl?: string | null;
  reason?: string;
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
}

/** auto_pr finalization: push the task branch and open a PR. Best-effort; null on failure. */
function pushAndOpenPr(cwd: string, branch: string): string | null {
  const pushed = git(["push", "-u", "origin", branch], cwd);
  if (!pushed.ok) return null;
  const pr = Bun.spawnSync(["gh", "pr", "create", "--fill", "--head", branch], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return pr.exitCode === 0 ? pr.stdout.toString().trim() : null;
}

export function buildDeliveryPrompt(
  task: { title: string; body: string },
  spec: string,
  verify: VerifyReport | null,
): string {
  const checks = (verify?.checks ?? []).map((c) => `${c.passed ? "✅" : "❌"} ${c.name}`).join(", ");
  return [
    "You are the Delivery agent. Produce a concise human summary of WHAT changed and WHY, referencing",
    "the acceptance criteria and the verify results. Be specific and skimmable. Output JSON only.",
    "",
    'Respond with ONLY this JSON shape: {"summary":"markdown","branch":"string|null","prUrl":"string|null"}',
    "",
    `TASK: ${task.title}`,
    task.body ? `DETAILS: ${task.body}` : "",
    spec.trim() ? `\nSPEC:\n${spec.trim()}` : "",
    checks ? `\nVERIFY CHECKS: ${checks}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Run Delivery (spec §7.7): a one-shot Haiku agent writes the human summary, then
 * Cadence finalizes deterministically per the resolved delivery mode —
 * branch_summary (commit lives on the per-task branch), auto_pr (push + `gh pr
 * create`), apply_in_place (changes already in rootPath). For an in-place
 * execution (worktrees disabled) the commit lands on the task branch in the
 * project working dir, then the base branch is restored so the repo — and every
 * queued read stage — sees its normal state again. Writes delivery.md. git/gh
 * steps are best-effort (a failure is noted, never thrown). `run` is injectable
 * so tests use the mock. Does not change task status (stays in review for the
 * human to merge in 3.7).
 */
export async function runDelivery(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<DeliveryOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false, reason: "task not found" };

  const mode = resolveDeliveryMode(db, taskId);
  let target: ExecutionTarget;
  try {
    target = resolveExecutionCwd(db, taskId);
  } catch {
    // summary-only fallback
    target = { cwd: process.cwd(), branch: null, worktreePath: null, inPlace: false, mode: "worktree" };
  }

  const result = await run({
    cwd: target.cwd,
    taskId,
    role: "delivery",
    prompt: buildDeliveryPrompt({ title: task.title, body: task.body }, readSpec(taskId), readVerify(taskId)),
    permissionMode: "plan",
  });

  const j = (result.json ?? null) as DeliveryJson | null;
  const summary = (j?.summary ?? result.text ?? "").trim() || "Changes delivered.";

  let branch: string | null = null;
  let prUrl: string | null = null;
  if (mode !== "apply_in_place") {
    branch = branchName({ id: task.id, title: task.title });
    if (target.worktreePath) {
      // Ensure the Implementer's changes are committed to the task branch. Deterministic — a direct
      // subprocess, so it never stalls on a permission gate the way an agent tool call can — and a
      // no-op when the Implementer already made its own commits (clean tree). This is what makes a
      // branch_summary delivery a real, reviewable branch even if a run was interrupted.
      const dirty = git(["status", "--porcelain"], target.worktreePath);
      if (dirty.ok && dirty.stdout) {
        git(["add", "-A"], target.worktreePath);
        git(["commit", "-m", `cadence: ${task.title}`], target.worktreePath);
      }
      if (mode === "auto_pr") prUrl = pushAndOpenPr(target.worktreePath, branch);
    } else if (target.inPlace && target.branch) {
      // In-place execution (worktrees disabled): commit tracked changes + NEW untracked files
      // onto the task branch — the pre-execution untracked snapshot (.env, scratch files)
      // never gets swallowed — then restore the base branch so the working dir is back to
      // normal for the user and the queued read stages.
      commitInPlaceChanges(target.cwd, taskId, `cadence: ${task.title}`);
      if (mode === "auto_pr") prUrl = pushAndOpenPr(target.cwd, branch);
      const fin = finalizeInPlaceExecution(db, taskId);
      if (!fin.restored) {
        appendContext(
          taskId,
          `Delivery left the repo on branch ${branch}: ${fin.reason ?? "could not restore the base branch"}.`,
        );
      }
    }
  }

  const delivery: DeliveryResult = { mode, summary, branch, prUrl };
  writeDelivery(taskId, delivery);
  return { ran: true, mode, branch, prUrl };
}
