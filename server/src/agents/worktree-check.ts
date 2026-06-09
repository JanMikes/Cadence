import type { WorktreeCheck, WorktreeCheckBlocker } from "@cadence/shared";
import type { Db } from "../db/client";
import { getProject, setProjectWorktreeCheck } from "../projects";
import { isGitRepo } from "../worktree";
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

export function buildWorktreeCheckPrompt(): string {
  return [
    "You are checking whether THIS repository (your cwd) can run Claude Code tasks from a FRESH",
    "git worktree — a second checkout of the repo in a sibling directory, starting with only the",
    "committed files (no untracked files, no installed dependencies, no running services).",
    "",
    "Inspect the repo (READ-ONLY) and look for blockers, e.g.:",
    "- required files that are NOT committed (.env / .env.local, config/*.local, secrets, certs)",
    "- a dev setup that assumes one fixed checkout: docker-compose with host-port bindings or",
    "  bind-mounts of the repo path, databases/services bound to fixed ports, absolute paths in",
    "  config or scripts, symlinks out of the repo",
    "- heavy per-checkout setup: dependency install (node_modules, vendor, venv), code generation,",
    "  build caches — note the cost, it's a soft blocker",
    "- git submodules / git-lfs (worktrees need an extra init step)",
    "- README/docs setup steps that would not work from a second checkout",
    "",
    "Weigh severity honestly: 'high' = tasks would fail or corrupt state, 'medium' = needs manual",
    "setup per worktree, 'low' = minor friction. If the repo is essentially self-contained after a",
    "dependency install, verdict is 'ready' (mention the install in the summary).",
    "",
    "Respond with ONLY this JSON shape:",
    '{"verdict":"ready|blockers","summary":"one short paragraph","blockers":[{"title":"string","detail":"string","severity":"high|medium|low"}],"recommendation":"string|null"}',
  ].join("\n");
}

const SEVERITIES = new Set(["high", "medium", "low"]);

/**
 * Ask Claude whether a project's repo is safe to run from a git worktree (§9:
 * propose, don't impose — the result informs the worktreesEnabled toggle, the
 * human flips it). Read-only "plan" mode in the repo cwd; the parsed verdict is
 * persisted on the project (worktreeCheck) so the UI can show it any time.
 * `run` is injectable so tests use the mock. Never throws.
 */
export async function runWorktreeCheck(
  db: Db,
  slug: string,
  run: AgentRunner = runAgent,
): Promise<WorktreeCheckOutcome> {
  const project = getProject(db, slug);
  if (!project) return { ran: false, reason: "project not found" };
  if (!project.rootPath) return { ran: false, reason: "project has no rootPath" };
  if (!isGitRepo(project.rootPath)) return { ran: false, reason: `${project.rootPath} is not a git repo` };

  const result = await run({
    cwd: project.rootPath,
    role: "worktree_check",
    prompt: buildWorktreeCheckPrompt(),
    permissionMode: "plan",
  });
  if (result.isError) return { ran: false, reason: "readiness check agent errored" };

  const j = (result.json ?? null) as WorktreeCheckJson | null;
  if (!j || typeof j !== "object" || (j.verdict !== "ready" && j.verdict !== "blockers")) {
    return { ran: false, reason: "readiness check returned no usable JSON" };
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
