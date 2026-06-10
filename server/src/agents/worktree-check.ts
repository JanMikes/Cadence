import type { WorktreeCheck, WorktreeCheckBlocker } from "@cadence/shared";
import type { Db } from "../db/client";
import { getProject, setProjectWorktreeCheck, setProjectWorktreeCheckRun } from "../projects";
import { isGitRepo } from "../worktree";
import { getAgentPrompt, projectPromptLayer } from "./prompts";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

/** The JSON the readiness-check agent returns. */
interface WorktreeCheckJson {
  verdict?: "ready" | "blockers";
  summary?: string;
  blockers?: Array<{ title?: string; detail?: string; severity?: string }>;
  recommendation?: string | null;
}

export interface WorktreeCheckOutcome {
  ran: boolean;
  check?: WorktreeCheck;
  reason?: string;
}

export function buildWorktreeCheckPrompt(
  project?: { name: string; agentPrompts: Record<string, string> | null } | null,
): string {
  // Project-scoped (no task), so it bypasses the recording runner — the project's
  // per-agent addition (§6.3.b) is composed here instead.
  const base = getAgentPrompt("worktree_check");
  const layer = projectPromptLayer(project, "worktree_check");
  return layer ? `${base}\n\n${layer}` : base;
}

const SEVERITIES = new Set(["high", "medium", "low"]);

/**
 * Ask Claude whether a project's repo is safe to run from a git worktree (§9:
 * propose, don't impose — the result informs the worktreesEnabled toggle, the
 * human flips it). Read-only "plan" mode in the repo cwd; the whole lifecycle is
 * persisted on the project — running → worktreeCheckRun, verdict → worktreeCheck,
 * failure → worktreeCheckRun with a reason — so the UI can show it any time, even
 * after the panel that started it closed. `run` is injectable so tests use the
 * mock. Never throws.
 */
export async function runWorktreeCheck(
  db: Db,
  slug: string,
  run: AgentRunner = runAgent,
): Promise<WorktreeCheckOutcome> {
  const project = getProject(db, slug);
  if (!project) return { ran: false, reason: "project not found" };
  if (!project.rootPath) return { ran: false, reason: "project has no rootPath" };

  const startedAt = Date.now();
  const fail = (reason: string): WorktreeCheckOutcome => {
    setProjectWorktreeCheckRun(db, slug, { status: "failed", startedAt, reason });
    return { ran: false, reason };
  };

  if (!isGitRepo(project.rootPath)) return fail(`${project.rootPath} is not a git repo`);

  // Persisted synchronously (before the first await) so the 202 response already
  // reflects a running check — any view that opens later sees "Checking…".
  setProjectWorktreeCheckRun(db, slug, { status: "running", startedAt, reason: null });

  let result: Awaited<ReturnType<AgentRunner>>;
  try {
    result = await run({
      cwd: project.rootPath,
      role: "worktree_check",
      prompt: buildWorktreeCheckPrompt(project),
      permissionMode: "plan",
    });
  } catch (err) {
    return fail(`readiness check crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.isError) return fail("readiness check agent errored");

  const j = (result.json ?? null) as WorktreeCheckJson | null;
  if (!j || typeof j !== "object" || (j.verdict !== "ready" && j.verdict !== "blockers")) {
    return fail("readiness check returned no usable JSON");
  }

  const blockers: WorktreeCheckBlocker[] = (j.blockers ?? [])
    .filter((b) => b && typeof b.title === "string" && b.title.trim())
    .map((b) => ({
      title: (b.title as string).trim(),
      detail: typeof b.detail === "string" ? b.detail.trim() : "",
      severity: SEVERITIES.has(b.severity ?? "") ? (b.severity as WorktreeCheckBlocker["severity"]) : "medium",
    }));

  const check: WorktreeCheck = {
    // An inconsistent agent answer ("ready" but with blockers listed) resolves to "blockers".
    verdict: j.verdict === "ready" && blockers.length === 0 ? "ready" : "blockers",
    summary: (j.summary ?? "").trim() || "(no summary)",
    blockers,
    recommendation: typeof j.recommendation === "string" && j.recommendation.trim() ? j.recommendation.trim() : null,
    checkedAt: Date.now(),
  };
  setProjectWorktreeCheck(db, slug, check);
  return { ran: true, check };
}
