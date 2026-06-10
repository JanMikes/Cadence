import type { DeliveryResult, ForgeKind, VerifyReport } from "@cadence/shared";
import type { Db } from "../db/client";
import { type CliExec, projectForgeStatus } from "../forge";
import { getProjectById } from "../projects";
import { appendContext, readSpec, readVerify, writeDelivery } from "../store/store";
import { getAgentPrompt, renderTemplate } from "./prompts";
import { getTaskDetail, resolveDeliveryMode, setTaskPrUrl } from "../tasks";
import {
  branchName,
  commitInPlaceChanges,
  type ExecutionTarget,
  finalizeInPlaceExecution,
  readExecutionState,
  resolveExecutionCwd,
} from "../worktree";
import { recordDeliveryGitContext } from "../git-context";
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

/** Shell seam for the push + PR/MR create steps, injectable for tests. */
export type ShellRunner = (cmd: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string };

const realShell: ShellRunner = (cmd, cwd) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
};

export interface PrAttempt {
  url: string | null;
  /** True when auto_pr couldn't complete — delivery degrades to branch_summary with `note`. */
  fellBack: boolean;
  note: string | null;
}

/**
 * auto_pr finalization (§6.4.d), forge-aware: push the task branch, then open a PR
 * (`gh pr create`) or MR (`glab mr create` ⚠ flags per glab docs) depending on the
 * project's forge. Never hard-fails the delivery — a missing/unauthenticated CLI, an
 * unknown forge or a failed push degrade to a branch-only delivery with a
 * plain-language note for the task's context channel.
 */
export function openPrForProject(
  project: { gitRemote: string | null; forgeOverride: ForgeKind | null } | null,
  cwd: string,
  branch: string,
  deps: { shell?: ShellRunner; probeExec?: CliExec } = {},
): PrAttempt {
  const shell = deps.shell ?? realShell;
  const status = projectForgeStatus(project?.gitRemote, project?.forgeOverride ?? null, {
    exec: deps.probeExec,
  });
  if (!status.remote?.forge) {
    return {
      url: null,
      fellBack: true,
      note: "auto_pr: no GitHub/GitLab remote detected on the project — delivered the branch without a PR/MR.",
    };
  }
  const forge = status.remote.forge;
  const cliName = forge === "github" ? "gh" : "glab";
  const kind = forge === "github" ? "PR" : "MR";
  if (!status.cli?.installed) {
    return {
      url: null,
      fellBack: true,
      note: `auto_pr: ${cliName} is not installed (brew install ${cliName}, then ${cliName} auth login) — delivered the branch without a ${kind}.`,
    };
  }
  if (!status.cli.authenticated) {
    return {
      url: null,
      fellBack: true,
      note: `auto_pr: ${cliName} is not signed in (${cliName} auth login) — delivered the branch without a ${kind}.`,
    };
  }
  const pushed = shell(["git", "push", "-u", "origin", branch], cwd);
  if (!pushed.ok) {
    return { url: null, fellBack: true, note: `auto_pr: push failed — ${pushed.stderr.slice(0, 200)}` };
  }
  const create =
    forge === "github"
      ? ["gh", "pr", "create", "--fill", "--head", branch]
      : ["glab", "mr", "create", "--fill", "--yes", "--source-branch", branch];
  const created = shell(create, cwd);
  if (!created.ok) {
    return {
      url: null,
      fellBack: true,
      note: `auto_pr: ${cliName} create failed — ${created.stderr.slice(0, 200)}`,
    };
  }
  const url = created.stdout.match(/https?:\/\/\S+/)?.[0] ?? null;
  return url
    ? { url, fellBack: false, note: null }
    : { url: null, fellBack: true, note: `auto_pr: ${cliName} did not return a ${kind} URL.` };
}

export function buildDeliveryPrompt(
  task: { title: string; body: string },
  spec: string,
  verify: VerifyReport | null,
): string {
  const checks = (verify?.checks ?? []).map((c) => `${c.passed ? "✅" : "❌"} ${c.name}`).join(", ");
  return renderTemplate(getAgentPrompt("delivery"), {
    title: task.title,
    detailsLine: task.body ? `DETAILS: ${task.body}` : "",
    specBlock: spec.trim() ? `\nSPEC:\n${spec.trim()}` : "",
    checksLine: checks ? `\nVERIFY CHECKS: ${checks}` : "",
  });
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
  let effectiveMode = mode;
  const project = task.projectId ? getProjectById(db, task.projectId) : null;
  const attemptPr = (cwd: string): void => {
    const attempt = openPrForProject(project, cwd, branch as string);
    if (attempt.url) {
      prUrl = attempt.url;
      setTaskPrUrl(db, taskId, attempt.url); // persisted on the task (frontmatter + index, §6.4.d)
    } else if (attempt.fellBack) {
      // Honest degrade: report what actually happened, and say why on the context channel.
      effectiveMode = "branch_summary";
      if (attempt.note) appendContext(taskId, attempt.note);
    }
  };
  // The in-place execution's recorded base — captured before finalize clears it, so
  // the git context knows what this branch should merge into.
  const baseBranchHint = readExecutionState(taskId)?.baseBranch ?? null;
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
      if (mode === "auto_pr") attemptPr(target.worktreePath);
    } else if (target.inPlace && target.branch) {
      // In-place execution (worktrees disabled): commit tracked changes + NEW untracked files
      // onto the task branch — the pre-execution untracked snapshot (.env, scratch files)
      // never gets swallowed — then restore the base branch so the working dir is back to
      // normal for the user and the queued read stages.
      const committed = commitInPlaceChanges(target.cwd, taskId, `cadence: ${task.title}`, target.branch);
      if (committed.reason) {
        appendContext(taskId, `Delivery couldn't commit: ${committed.reason}.`);
      }
      if (mode === "auto_pr") attemptPr(target.cwd);
      const fin = finalizeInPlaceExecution(db, taskId);
      if (!fin.restored) {
        appendContext(
          taskId,
          `Delivery left the repo on branch ${branch}: ${fin.reason ?? "could not restore the base branch"}.`,
        );
      }
    }
  }

  const delivery: DeliveryResult = { mode: effectiveMode, summary, branch, prUrl };
  writeDelivery(taskId, delivery);
  // Record the git outcome (branch · base · tip commit · merged?) on the task itself —
  // what the board chip and the background merge-detection sweep read.
  recordDeliveryGitContext(db, taskId, {
    mode,
    branch,
    rootPath: project?.rootPath ?? null,
    baseBranchHint,
  });
  return { ran: true, mode: effectiveMode, branch, prUrl };
}
