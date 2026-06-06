import type { DeliveryResult, VerifyReport } from "@cadence/shared";
import type { Db } from "../db/client";
import { readSpec, readVerify, writeDelivery } from "../store/store";
import { getTaskDetail, resolveDeliveryMode } from "../tasks";
import { branchName, resolveExecutionCwd } from "../worktree";
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
 * create`), apply_in_place (changes already in rootPath). Writes delivery.md.
 * git/gh steps are best-effort (a failure is noted, never thrown). `run` is
 * injectable so tests use the mock. Does not change task status (stays in review
 * for the human to merge in 3.7).
 */
export async function runDelivery(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<DeliveryOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false, reason: "task not found" };

  const mode = resolveDeliveryMode(db, taskId);
  let target: { cwd: string; worktreePath: string | null };
  try {
    target = resolveExecutionCwd(db, taskId);
  } catch {
    target = { cwd: process.cwd(), worktreePath: null }; // summary-only fallback
  }

  const result = await run({
    cwd: target.cwd,
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
    if (mode === "auto_pr" && target.worktreePath) {
      const pushed = git(["push", "-u", "origin", branch], target.worktreePath);
      if (pushed.ok) {
        const pr = Bun.spawnSync(["gh", "pr", "create", "--fill", "--head", branch], {
          cwd: target.worktreePath,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (pr.exitCode === 0) prUrl = pr.stdout.toString().trim();
      }
    }
  }

  const delivery: DeliveryResult = { mode, summary, branch, prUrl };
  writeDelivery(taskId, delivery);
  return { ran: true, mode, branch, prUrl };
}
