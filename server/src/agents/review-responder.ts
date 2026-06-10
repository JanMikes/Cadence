import type { ReviewProposal, ReviewThreadProposal } from "@cadence/shared";
import type { Db } from "../db/client";
import { parsePrUrl, projectForgeStatus } from "../forge";
import { type ForgeReviewApi, forgeReviewApi } from "../forge-review";
import { getProjectById } from "../projects";
import { withReadAccess } from "../project-locks";
import { appendContext, readReviewProposal, writeReviewProposal } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
import { getAgentPrompt, renderTemplate } from "./prompts";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

export interface ResponderOutcome {
  ran: boolean;
  status?: string;
  threads?: number;
  reason?: string;
}

const CLASSIFICATIONS = new Set(["must_fix", "question", "preference", "pushback"]);

interface ResponderJson {
  threads?: Array<{
    threadId?: string;
    classification?: string;
    reply?: string;
    patch?: string | null;
    resolves?: boolean;
  }>;
  overallNote?: string;
}

export function normalizeProposal(j: ResponderJson): ReviewProposal {
  const threads: ReviewThreadProposal[] = (j.threads ?? [])
    .map((t) => {
      const threadId = (t.threadId ?? "").trim();
      if (!threadId) return null;
      const out: ReviewThreadProposal = {
        threadId,
        classification: CLASSIFICATIONS.has(t.classification ?? "") ? (t.classification as string) : "question",
        reply: (t.reply ?? "").trim(),
        resolves: t.resolves === true,
      };
      if (t.patch?.trim()) out.patch = t.patch;
      return out;
    })
    .filter((t): t is ReviewThreadProposal => t !== null);
  return { threads, overallNote: (j.overallNote ?? "").trim(), generatedAt: Date.now() };
}

/**
 * Propose phase (address direction, §6.5.d): fetch the unresolved threads
 * deterministically, let the responder classify + draft a fix/reply per thread, and
 * park the task in `plan_review` — the proposal IS the plan; the human approves it
 * in the Review Workspace before anything is applied or posted.
 */
export async function runReviewResponderPropose(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
  apiFactory: (forge: "github" | "gitlab") => ForgeReviewApi = forgeReviewApi,
): Promise<ResponderOutcome> {
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

  let threads: ReturnType<ForgeReviewApi["fetchThreads"]>;
  try {
    threads = apiFactory(ref.forge)
      .fetchThreads(ref)
      .filter((t) => !t.resolved);
  } catch (err) {
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(
      taskId,
      `Review: couldn't fetch the threads (${(err as Error).message.slice(0, 200)}). ` +
        "Check the Repository card on the project, then re-run.",
    );
    return { ran: true, status: "needs_feedback", reason: "forge fetch failed" };
  }

  if (threads.length === 0) {
    // Nothing unresolved — an honest, happy outcome: the workspace shows it as such.
    writeReviewProposal(taskId, { threads: [], overallNote: "No unresolved feedback 🎉", generatedAt: Date.now() });
    updateTask(db, taskId, { status: "review" });
    return { ran: true, status: "review", threads: 0 };
  }

  const project = task.projectId ? getProjectById(db, task.projectId) : null;
  const me =
    projectForgeStatus(project?.gitRemote, project?.forgeOverride ?? null).cli?.account ?? "the user";

  const prompt = renderTemplate(getAgentPrompt("review_responder"), {
    me,
    prKind: ref.kind === "pr" ? "PR" : "MR",
    reviewRef: task.reviewRef,
    taskDescription: task.body?.trim() ?? "",
    threadsJson: JSON.stringify(
      threads.map((t) => ({
        id: t.id,
        file: t.file,
        line: t.line,
        comments: t.comments.map((c) => ({ author: c.author, body: c.body })),
      })),
    ),
  });

  const result = await withReadAccess(db, taskId, () =>
    run({ cwd: resolveTaskCwd(db, taskId), taskId, role: "review_responder", prompt, permissionMode: "plan" }),
  );

  const j = (result.json ?? null) as ResponderJson | null;
  if (!j || typeof j !== "object") {
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(taskId, "Review: the responder returned no parseable proposal — add context or re-run.");
    return { ran: true, status: "needs_feedback", reason: "unparseable output" };
  }
  const proposal = normalizeProposal(j);
  writeReviewProposal(taskId, proposal);
  updateTask(db, taskId, { status: "plan_review" });
  return { ran: true, status: "plan_review", threads: proposal.threads.length };
}

/**
 * Apply phase (§6.5.d), run after the human approves the proposal: an
 * implementer-style agent applies the ACCEPTED fixes on the PR branch (the API
 * chain holds the project write lock and Cadence handles the branch switching
 * deterministically — see review-branch.ts). Replies stay queued for the workspace;
 * posting them is a separate explicit-confirm action (6.5.f).
 */
export async function runReviewResponderApply(
  db: Db,
  taskId: string,
  cwd: string,
  run: AgentRunner = runAgent,
): Promise<ResponderOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false, reason: "task not found" };
  const proposal = readReviewProposal(taskId);
  if (!proposal) return { ran: false, reason: "no proposal to apply" };

  const accepted = proposal.threads.filter(
    (t) => t.decision !== "skip" && (t.classification === "must_fix" || t.classification === "preference") && t.patch,
  );
  if (accepted.length === 0) {
    // Nothing to change on the branch — straight to replying (review state).
    updateTask(db, taskId, { status: "review" });
    return { ran: true, status: "review", threads: 0 };
  }

  const work = accepted
    .map(
      (t, i) =>
        `${i + 1}. Thread ${t.threadId} (${t.classification}): apply this change\n${t.patch}\n   Reply drafted: ${t.editedReply ?? t.reply}`,
    )
    .join("\n");
  const prompt = [
    "You are applying APPROVED review-feedback fixes on the CURRENT branch of this repository",
    "(Cadence already checked out the PR/MR branch — do NOT switch branches).",
    "Apply each accepted change below (the patches are guidance — adapt line numbers to the live",
    "code), run the project's relevant tests for what you touch, and make focused commits with",
    "clear messages. Do not push; Cadence pushes after you finish.",
    "",
    "ACCEPTED CHANGES:",
    work,
  ].join("\n");

  const result = await run({
    cwd,
    taskId,
    role: "review_responder",
    prompt,
    permissionMode: "acceptEdits",
  });

  if (result.isError) {
    appendContext(taskId, "Review apply: the agent run errored — inspect its session, then re-approve to retry.");
    updateTask(db, taskId, { status: "plan_review" });
    return { ran: true, status: "plan_review", reason: "apply run errored" };
  }
  writeReviewProposal(taskId, { ...proposal, appliedAt: Date.now() });
  updateTask(db, taskId, { status: "review" });
  return { ran: true, status: "review", threads: accepted.length };
}
