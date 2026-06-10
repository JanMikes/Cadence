import type { TaskPlan, VerifyCheck, VerifyCriterion, VerifyIssue, VerifyReport } from "@cadence/shared";
import type { Db } from "../db/client";
import { readPlan, readSpec, writeVerify } from "../store/store";
import { getTaskDetail, updateTask } from "../tasks";
import { resolveExecutionCwd } from "../worktree";
import { agentsJson } from "./library";
import { getAgentPrompt, renderTemplate } from "./prompts";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

/** The JSON the Verifier returns (agent-prompts.md §6). */
export interface VerifierJson {
  passed?: boolean;
  criteria?: Array<{ criterion?: string; met?: boolean; evidence?: string }>;
  checks?: Array<{ name?: string; passed?: boolean; output?: string }>;
  issues?: Array<{ severity?: string; detail?: string; file?: string }>;
}

export interface VerifierOutcome {
  ran: boolean;
  passed?: boolean;
  status?: string;
  reason?: string;
}

/** Diverse, independent reviewer lenses injected per verify run (spec §7.2). */
const VERIFY_SUBAGENTS = ["security-reviewer", "test-reviewer", "convention-reviewer", "smoke-tester"];

export function buildVerifierPrompt(
  task: { title: string; body: string },
  spec: string,
  plan: TaskPlan,
): string {
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
  return renderTemplate(getAgentPrompt("verifier"), {
    title: task.title,
    detailsLine: task.body ? `DETAILS: ${task.body}` : "",
    specBlock: spec.trim() ? `\nSPEC:\n${spec.trim()}` : "",
    planBlock: steps ? `\nPLAN:\n${steps}` : "",
  });
}

/** Normalize the agent JSON into a clean report (omit undefined nested keys). */
export function normalizeReport(j: VerifierJson): VerifyReport {
  const criteria: VerifyCriterion[] = (j.criteria ?? [])
    .map((c) => {
      const criterion = (c.criterion ?? "").trim();
      if (!criterion) return null;
      const out: VerifyCriterion = { criterion, met: c.met === true };
      if (c.evidence?.trim()) out.evidence = c.evidence.trim();
      return out;
    })
    .filter((c): c is VerifyCriterion => c !== null);
  const checks: VerifyCheck[] = (j.checks ?? [])
    .map((c) => {
      const name = (c.name ?? "").trim();
      if (!name) return null;
      const out: VerifyCheck = { name, passed: c.passed === true };
      if (c.output?.trim()) out.output = c.output.trim();
      return out;
    })
    .filter((c): c is VerifyCheck => c !== null);
  const issues: VerifyIssue[] = (j.issues ?? [])
    .map((i) => {
      const detail = (i.detail ?? "").trim();
      if (!detail) return null;
      const out: VerifyIssue = { severity: (i.severity ?? "low").trim() || "low", detail };
      if (i.file?.trim()) out.file = i.file.trim();
      return out;
    })
    .filter((i): i is VerifyIssue => i !== null);
  return { passed: j.passed === true, criteria, checks, issues };
}

/** Apply a parsed verify result: write verify.md + route the task. */
export function applyVerify(db: Db, taskId: string, j: VerifierJson): VerifierOutcome {
  const report = normalizeReport(j);
  writeVerify(taskId, report);
  // Pass → Review (the human merges, 3.7). Fail → back to Implementing.
  const status = report.passed ? "review" : "implementing";
  updateTask(db, taskId, { status });
  return { ran: true, passed: report.passed, status };
}

/**
 * Run the Verifier on a task (spec §7.6): locate the isolated worktree (idempotent
 * re-provision → same tree the Implementer used), run a one-shot Sonnet agent there
 * with the diverse reviewer subagents injected, parse pass/fail, and route the task.
 * `acceptEdits` so the smoke-tester can run build/tests; the prompt forbids fixing.
 * `run` is injectable so tests use the mock. Bails gracefully (never throws).
 */
export async function runVerifier(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<VerifierOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false, reason: "task not found" };

  let target: { cwd: string };
  try {
    target = resolveExecutionCwd(db, taskId);
  } catch (err) {
    return { ran: false, reason: (err as Error).message };
  }

  const result = await run({
    cwd: target.cwd,
    taskId,
    role: "verifier",
    prompt: buildVerifierPrompt({ title: task.title, body: task.body }, readSpec(taskId), readPlan(taskId)),
    permissionMode: "acceptEdits",
    agentsJson: agentsJson(VERIFY_SUBAGENTS),
  });

  const j = (result.json ?? null) as VerifierJson | null;
  if (!j || typeof j !== "object") return { ran: false, reason: "verifier returned no JSON" };
  return applyVerify(db, taskId, j);
}
