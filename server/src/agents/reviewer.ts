import type { ReviewFinding, ReviewFindings, ReviewVerdict } from "@cadence/shared";
import type { Db } from "../db/client";
import { parsePrUrl } from "../forge";
import { type ForgeReviewApi, forgeReviewApi } from "../forge-review";
import { withReadAccess } from "../project-locks";
import { readSettings, writeReviewFindings } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
import { appendContext } from "../store/store";
import { getAgentPrompt, renderTemplate } from "./prompts";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

/** Cap the embedded diff for token economy; the agent reads the repo for the rest. */
const DIFF_CAP_CHARS = 150_000;

export interface ReviewerOutcome {
  ran: boolean;
  status?: string;
  findings?: number;
  reason?: string;
}

export function buildReviewerPrompt(vars: {
  prKind: string;
  reviewRef: string;
  taskDescription: string;
  strictness: string;
  prMeta: string;
  prDiff: string;
}): string {
  const truncated = vars.prDiff.length > DIFF_CAP_CHARS;
  return renderTemplate(getAgentPrompt("reviewer"), {
    ...vars,
    prDiff: truncated ? vars.prDiff.slice(0, DIFF_CAP_CHARS) : vars.prDiff,
    diffTruncatedNote: truncated ? ", truncated" : "",
  });
}

const SEVERITIES = new Set(["blocker", "major", "minor", "nit"]);
const VERDICTS = new Set(["approve", "comment", "request_changes"]);

interface ReviewerJson {
  summary?: string;
  verdictSuggestion?: string;
  findings?: Array<{
    severity?: string;
    file?: string;
    line?: number;
    title?: string;
    body?: string;
    evidence?: string;
    suggestedPatch?: string | null;
  }>;
}

/** Normalize the agent's JSON into clean findings (drop entries without an anchor/title). */
export function normalizeFindings(j: ReviewerJson): ReviewFindings {
  const findings: ReviewFinding[] = (j.findings ?? [])
    .map((f) => {
      const title = (f.title ?? "").trim();
      const file = (f.file ?? "").trim();
      if (!title || !file) return null;
      const out: ReviewFinding = {
        severity: SEVERITIES.has(f.severity ?? "") ? (f.severity as string) : "minor",
        file,
        line: typeof f.line === "number" && f.line > 0 ? Math.floor(f.line) : 1,
        title,
        body: (f.body ?? "").trim(),
      };
      if (f.evidence?.trim()) out.evidence = f.evidence.trim();
      if (f.suggestedPatch?.trim()) out.suggestedPatch = f.suggestedPatch;
      return out;
    })
    .filter((f): f is ReviewFinding => f !== null);
  return {
    summary: (j.summary ?? "").trim(),
    verdictSuggestion: VERDICTS.has(j.verdictSuggestion ?? "")
      ? (j.verdictSuggestion as ReviewVerdict)
      : "comment",
    findings,
    generatedAt: Date.now(),
  };
}

/**
 * Run the Reviewer (perform direction, §6.5.c): Cadence pre-fetches the PR/MR meta +
 * diff DETERMINISTICALLY via the forge data layer (the agent never needs gh/glab —
 * read-only plan mode holds), the agent reviews against the live repo (read lock),
 * and the findings land as task artifacts for the Review Workspace. The task parks
 * in `review` (human triage of findings); it NEVER auto-publishes.
 */
export async function runReviewer(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
  apiFactory: (forge: "github" | "gitlab") => ForgeReviewApi = forgeReviewApi,
): Promise<ReviewerOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false, reason: "task not found" };
  if (task.taskType !== "code_review" || !task.reviewRef) {
    return { ran: false, reason: "not a code-review task" };
  }
  const ref = parsePrUrl(task.reviewRef);
  if (!ref) {
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(taskId, `Review: couldn't parse a PR/MR from "${task.reviewRef}" — fix the link and re-run.`);
    return { ran: true, status: "needs_feedback", reason: "unparseable reviewRef" };
  }

  let prMeta = "";
  let prDiff = "";
  try {
    const api = apiFactory(ref.forge);
    const meta = api.fetchMeta(ref);
    prMeta = [
      `Title: ${meta.title}`,
      `Author: ${meta.author ?? "?"} · State: ${meta.state}`,
      `Branches: ${meta.baseBranch ?? "?"} ← ${meta.headBranch ?? "?"} · CI: ${meta.ciStatus ?? "none"}`,
      meta.body ? `Description:\n${meta.body}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    prDiff = api.fetchDiff(ref);
  } catch (err) {
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(
      taskId,
      `Review: couldn't fetch the ${ref.kind.toUpperCase()} via ${ref.forge === "github" ? "gh" : "glab"} ` +
        `(${(err as Error).message.slice(0, 200)}). Check the Repository card on the project, then re-run.`,
    );
    return { ran: true, status: "needs_feedback", reason: "forge fetch failed" };
  }

  const prompt = buildReviewerPrompt({
    prKind: ref.kind === "pr" ? "PR" : "MR",
    reviewRef: task.reviewRef,
    taskDescription: task.body?.trim() ?? "",
    strictness: readSettings().review?.strictness ?? "standard",
    prMeta,
    prDiff,
  });

  const result = await withReadAccess(db, taskId, () =>
    run({
      cwd: resolveTaskCwd(db, taskId),
      taskId,
      role: "reviewer",
      prompt,
      permissionMode: "plan",
    }),
  );

  const j = (result.json ?? null) as ReviewerJson | null;
  if (!j || typeof j !== "object") {
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(taskId, "Review: the reviewer returned no parseable findings — add context or re-run.");
    return { ran: true, status: "needs_feedback", reason: "unparseable output" };
  }
  const findings = normalizeFindings(j);
  writeReviewFindings(taskId, findings);
  updateTask(db, taskId, { status: "review" });
  return { ran: true, status: "review", findings: findings.findings.length };
}
