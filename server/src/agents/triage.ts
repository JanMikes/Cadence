import type { AgentResult } from "@cadence/shared";
import type { Db } from "../db/client";
import { withReadAccess } from "../project-locks";
import { listProjects } from "../projects";
import { appendContext, readQa, readTask, writeQa, writeTask } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
import { getAgentPrompt, renderTemplate, TITLE_NAMING_INSTRUCTION } from "./prompts";
import { type AgentRunOptions, runAgent } from "./runner";

export type AgentRunner = (opts: AgentRunOptions) => Promise<AgentResult>;

/** The JSON the Triage agent returns (agent-prompts.md §1). */
export interface TriageJson {
  sufficiency?: "ok" | "insufficient";
  needFromUser?: string | null;
  restatement?: string;
  /** A proper task title — requested when capture was description-only. */
  title?: string;
  projectSlug?: string | null;
  /** When the agent abstains from routing (not confident): 1-3 plausible slugs. */
  projectCandidates?: string[];
  fleetName?: string | null;
  isMultiRepo?: boolean;
  priority?: string;
  deadline?: string | null;
  labels?: string[];
  /** Review classification (6.5.a) — adopted only when capture didn't already decide. */
  taskType?: string;
  reviewDirection?: string;
  reviewRef?: string | null;
}

export interface TriageOutcome {
  ran: boolean;
  status?: string; // resulting task status
  restatement?: string;
  needFromUser?: string;
  /** True when triage abstained on the project and asked via a Q&A card. */
  askedProject?: boolean;
  /** True when the run stopped on an interactive ask (already surfaced + notified). */
  askedUser?: boolean;
}

/** Question id of the "which project?" card triage writes when it can't route confidently. */
export const TRIAGE_PROJECT_QUESTION_ID = "triage-project";

/** Q&A option meaning "assign no project". */
export const TRIAGE_PROJECT_NONE = "None";

export function buildTriagePrompt(
  raw: { title: string; body: string },
  projectList: Array<{ slug: string; name: string }>,
  opts: {
    titleNeeded?: boolean;
    /** Capture-pinned fields, as human-readable values (e.g. project=acme, deadline=(none)). */
    fixed?: Array<{ field: "project" | "priority" | "deadline"; value: string }>;
  } = {},
): string {
  // The instructions live in the editable prompt registry (§6.3.a); this builder only
  // computes the variables. Conditional fragments are whole-line vars — empty → line drops.
  return renderTemplate(getAgentPrompt("triage"), {
    title: raw.title,
    bodyLine: raw.body ? `TASK BODY: ${raw.body}` : "",
    projects: projectList.length
      ? projectList.map((p) => `${p.slug} (${p.name})`).join(", ")
      : "(none yet)",
    fixedLine: opts.fixed?.length
      ? `Already decided by the user — do NOT output or change these fields: ${opts.fixed
          .map((f) => `${f.field}=${f.value}`)
          .join(", ")}.`
      : "",
    titleInstruction: opts.titleNeeded ? TITLE_NAMING_INSTRUCTION : "",
    titleField: opts.titleNeeded ? '"title":"string",' : "",
  });
}

/** Apply a parsed triage result to the task (deterministic; no model). */
export function applyTriage(db: Db, taskId: string, j: TriageJson): TriageOutcome {
  // The agent names the task only when the title is still a derived placeholder —
  // a user-written title is never overwritten (propose, don't impose).
  const agentTitle =
    getTaskDetail(db, taskId)?.titleGenerated && j.title?.trim() ? j.title.trim() : undefined;

  if (j.sufficiency === "insufficient") {
    updateTask(db, taskId, { status: "needs_feedback", ...(agentTitle && { title: agentTitle }) });
    const need = j.needFromUser?.trim();
    if (need) appendContext(taskId, `Triage needs more info: ${need}`);
    return { ran: true, status: "needs_feedback", needFromUser: need };
  }

  // Capture-pinned fields are the user's explicit decision — skipped here no matter
  // what the model returned (the prompt also tells it not to, but this is the guarantee).
  const fixed = new Set(readTask(taskId).data.fixedFields ?? []);

  const patch: Parameters<typeof updateTask>[2] = { status: "triaged" };
  if (agentTitle) patch.title = agentTitle;
  // Review classification (6.5.a): triage may recognize a review task captured as plain
  // text — but a capture-time decision (the chips) always wins, never overwrite it.
  if (j.taskType === "code_review" && getTaskDetail(db, taskId)?.taskType !== "code_review") {
    patch.taskType = "code_review";
    patch.reviewDirection = j.reviewDirection === "address" ? "address" : "perform";
    if (j.reviewRef?.trim()) patch.reviewRef = j.reviewRef.trim();
  }
  if (!fixed.has("project") && j.projectSlug) patch.project = j.projectSlug;
  if (!fixed.has("priority") && j.priority) patch.priority = j.priority;
  if (Array.isArray(j.labels) && j.labels.length) patch.labels = j.labels;
  if (!fixed.has("deadline") && j.deadline) {
    const ms = Date.parse(j.deadline);
    if (!Number.isNaN(ms)) patch.deadline = ms;
  }

  // The agent abstained on the project (not confident): don't guess — ask. The card
  // reuses the qa.md mechanism, so it surfaces in the Attention Center and is answered
  // like any other question; everything else triage decided still applies below.
  const slugs = listProjects(db).map((p) => p.slug);
  const candidates = (j.projectCandidates ?? []).filter(
    (s) => typeof s === "string" && slugs.includes(s),
  );
  if (!fixed.has("project") && !j.projectSlug && candidates.length) {
    const options = [
      ...new Set([...candidates, ...slugs]),
      TRIAGE_PROJECT_NONE,
    ];
    const qa = readQa(taskId);
    writeQa(taskId, {
      questions: [
        {
          id: TRIAGE_PROJECT_QUESTION_ID,
          rank: 0,
          type: "single_choice",
          text: "Which project does this task belong to?",
          options,
          why: "Triage wasn't confident enough to route this automatically.",
        },
        ...qa.questions.filter((q) => q.id !== TRIAGE_PROJECT_QUESTION_ID),
      ],
      answers: qa.answers,
    });
    patch.status = "needs_feedback";
    updateTask(db, taskId, patch);
    if (j.restatement?.trim()) appendContext(taskId, `Triage restatement: ${j.restatement.trim()}`);
    return { ran: true, status: "needs_feedback", askedProject: true, restatement: j.restatement?.trim() };
  }

  updateTask(db, taskId, patch);
  if (j.restatement?.trim()) appendContext(taskId, `Triage restatement: ${j.restatement.trim()}`);
  return { ran: true, status: "triaged", restatement: j.restatement?.trim() };
}

/**
 * Apply the user's answer to the triage "which project?" card: assign the project
 * (pinning it so nothing second-guesses the user), drop the card from qa.md (the
 * Questioner later rewrites qa.md wholesale — this question must never be part of
 * its all-answered → ready math), and move needs_feedback → triaged so the caller
 * can resume the refinement pipeline.
 */
export function applyTriageProjectAnswer(
  db: Db,
  taskId: string,
  choice: string,
): { ok: boolean; resume: boolean; reason?: string } {
  const qa = readQa(taskId);
  const question = qa.questions.find((q) => q.id === TRIAGE_PROJECT_QUESTION_ID);
  if (!question) return { ok: false, resume: false, reason: "no pending project question" };

  const known = listProjects(db).some((p) => p.slug === choice);
  if (choice !== TRIAGE_PROJECT_NONE && !known) {
    return { ok: false, resume: false, reason: `unknown project "${choice}"` };
  }

  appendContext(taskId, `Q: ${question.text}\nA: ${choice}`);
  writeQa(taskId, {
    questions: qa.questions.filter((q) => q.id !== TRIAGE_PROJECT_QUESTION_ID),
    answers: Object.fromEntries(
      Object.entries(qa.answers).filter(([k]) => k !== TRIAGE_PROJECT_QUESTION_ID),
    ),
  });

  // The user's answer is a pin — record it in frontmatter like a capture-time pick.
  const { data, body } = readTask(taskId);
  data.fixedFields = [...new Set([...(data.fixedFields ?? []), "project"])];
  writeTask(data, body);

  const patch: Parameters<typeof updateTask>[2] = {
    project: choice === TRIAGE_PROJECT_NONE ? null : choice,
  };
  // Only the explicit waiting states advance — if the user already moved the task
  // elsewhere, apply the project but never yank the lifecycle sideways.
  const status = getTaskDetail(db, taskId)?.status;
  const resume = status === "needs_feedback" || status === "inbox";
  if (resume) patch.status = "triaged";
  updateTask(db, taskId, patch);
  return { ok: true, resume };
}

/**
 * Run the Triage agent on a freshly-captured task: compose the prompt, run a
 * one-shot Haiku agent (read-only "plan" mode), parse its JSON, and apply it.
 * `run` is injectable so tests use the mock (no real model). Returns the outcome.
 */
export async function runTriage(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<TriageOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false };

  // Tell the model which fields the user pinned at capture (applyTriage also skips
  // them deterministically — this just stops the model wasting effort on them).
  const fm = readTask(taskId).data;
  const fixed: Array<{ field: "project" | "priority" | "deadline"; value: string }> = [];
  for (const field of fm.fixedFields ?? []) {
    if (field === "project") fixed.push({ field, value: fm.project ?? "(none)" });
    else if (field === "priority") fixed.push({ field, value: fm.priority ?? "(none)" });
    else if (field === "deadline") {
      const value =
        typeof fm.deadline === "string" ? fm.deadline.slice(0, 10) : fm.deadline ? String(fm.deadline) : "(none)";
      fixed.push({ field, value });
    }
  }

  const prompt = buildTriagePrompt(
    { title: task.title, body: task.body },
    listProjects(db).map((p) => ({ slug: p.slug, name: p.name })),
    { titleNeeded: task.titleGenerated, fixed },
  );
  // Read lock: queued behind an in-place execution so triage never reads a
  // half-written task branch; shared with the other read stages.
  const result = await withReadAccess(db, taskId, () =>
    run({
      cwd: resolveTaskCwd(db, taskId),
      taskId,
      role: "triage",
      prompt,
      permissionMode: "plan",
    }),
  );

  const j = (result.json ?? null) as TriageJson | null;
  if (!j || typeof j !== "object") {
    // The run stopped to ask and the wrapper already parked the task (Q&A + Needs-input).
    // Report it as handled so callers don't retry on top. Keyed on askParked, never asks alone.
    if (result.askParked) return { ran: true, status: "needs_feedback", askedUser: true };
    return { ran: false }; // couldn't parse — leave in Inbox
  }
  return applyTriage(db, taskId, j);
}
