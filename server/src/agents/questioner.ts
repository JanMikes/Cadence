import type { QAQuestion } from "@cadence/shared";
import type { Db } from "../db/client";
import { withReadAccess } from "../project-locks";
import { appendContext, readQa, readSpec, writeQa } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
import { getAgentPrompt, renderTemplate } from "./prompts";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

interface QuestionerJson {
  questions?: Array<{
    id?: string;
    rank?: number;
    type?: string;
    text?: string;
    options?: string[];
    why?: string;
  }>;
}

export interface QuestionerOutcome {
  ran: boolean;
  status?: string;
  questions?: QAQuestion[];
}

export function buildQuestionerPrompt(spec: string, task: { title: string }): string {
  return renderTemplate(getAgentPrompt("questioner"), {
    title: task.title,
    specText: spec || "(no spec yet)",
  });
}

const VALID_TYPES = new Set(["text", "single_choice", "multi_choice", "boolean"]);

function normalize(raw: QuestionerJson["questions"]): QAQuestion[] {
  const out: QAQuestion[] = [];
  (raw ?? []).forEach((q, i) => {
    const text = (q.text ?? "").trim();
    if (!text) return;
    // Build without undefined keys — YAML serialization (qa.md) can't dump undefined.
    const question: QAQuestion = {
      id: q.id?.trim() || `q${i + 1}`,
      rank: typeof q.rank === "number" ? q.rank : i + 1,
      type: q.type && VALID_TYPES.has(q.type) ? q.type : "text",
      text,
    };
    if (Array.isArray(q.options) && q.options.length) question.options = q.options;
    if (q.why?.trim()) question.why = q.why.trim();
    out.push(question);
  });
  return out;
}

/**
 * Run the Questioner on a task in Refining: turn the spec's unknowns into ranked
 * Q&A cards (qa.md) and move the task to Needs-Feedback. If it has nothing to ask,
 * the task is Ready. `run` is injectable so tests use the mock.
 */
export async function runQuestioner(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<QuestionerOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false };

  // Read lock: shared with the other read stages, queued behind an in-place execution.
  const result = await withReadAccess(db, taskId, () =>
    run({
      cwd: resolveTaskCwd(db, taskId),
      taskId,
      role: "questioner",
      prompt: buildQuestionerPrompt(readSpec(taskId), { title: task.title }),
      permissionMode: "plan",
    }),
  );

  const j = (result.json ?? null) as QuestionerJson | null;
  if (!j || !Array.isArray(j.questions)) {
    // Don't strand the task in Refining — surface it so the user can review the spec, add context, or
    // run it manually (same never-stuck contract as Discovery).
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(
      taskId,
      "Refinement flagged open questions but the Questioner couldn't formulate them. " +
        "Review the spec, add context, or run Claude on this task manually.",
    );
    return { ran: true, status: "needs_feedback" };
  }

  const questions = normalize(j.questions);
  if (questions.length === 0) {
    updateTask(db, taskId, { status: "ready" });
    return { ran: true, status: "ready", questions: [] };
  }

  writeQa(taskId, { questions, answers: {} });
  updateTask(db, taskId, { status: "needs_feedback" });
  return { ran: true, status: "needs_feedback", questions };
}

function fmtAnswer(a: string | string[]): string {
  return Array.isArray(a) ? a.join(", ") : a;
}

/**
 * Record answers to a task's Q&A. New/changed answers are appended to the context
 * channel (so they compose into later runs). When every question is answered, the
 * task advances to Ready; otherwise it stays in Needs-Feedback.
 */
export function answerQuestions(
  db: Db,
  taskId: string,
  answers: Record<string, string | string[]>,
): { status: string } {
  const qa = readQa(taskId);
  const merged = { ...qa.answers, ...answers };
  writeQa(taskId, { questions: qa.questions, answers: merged });

  for (const q of qa.questions) {
    const a = merged[q.id];
    const prev = qa.answers[q.id];
    const given = a != null && a !== "" && !(Array.isArray(a) && a.length === 0);
    // Only NEW or CHANGED answers land on the context channel — re-submitting the
    // card (it stays editable in Needs-Feedback) must not duplicate Q&A pairs into
    // every later agent run.
    if (given && (prev == null || fmtAnswer(a) !== fmtAnswer(prev))) {
      appendContext(taskId, `Q: ${q.text}\nA: ${fmtAnswer(a)}`);
    }
  }

  const allAnswered = qa.questions.every((q) => {
    const a = merged[q.id];
    return a != null && a !== "" && !(Array.isArray(a) && a.length === 0);
  });
  // Only the explicit waiting state advances via answers — answering from any other
  // status (editing answers while refining/blocked, …) records them but never yanks
  // the lifecycle sideways.
  const current = getTaskDetail(db, taskId)?.status;
  if (current === "needs_feedback") {
    const status = allAnswered && qa.questions.length > 0 ? "ready" : "needs_feedback";
    updateTask(db, taskId, { status });
    return { status };
  }
  return { status: current ?? "needs_feedback" };
}
