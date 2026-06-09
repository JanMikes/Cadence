import type { QAQuestion } from "@cadence/shared";
import type { Db } from "../db/client";
import { appendContext, readQa, readSpec, writeQa } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
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
  return [
    "You are the Questioner agent. Given the Discovery spec (incl. its unknowns) and the task,",
    "write the SMALLEST set of high-leverage questions needed to unblock implementation — ranked,",
    "each with a type (text | single_choice | multi_choice | boolean) and options where useful, and a",
    "one-line 'why'. Never ask what the spec/context already answers. If one blocker overrides, ask",
    "only that. Output JSON only.",
    "",
    "Respond with ONLY this JSON shape:",
    '{"questions":[{"id":"q1","rank":1,"type":"single_choice","text":"string","options":["string"],"why":"string"}]}',
    "",
    `TASK: ${task.title}`,
    "",
    "SPEC:",
    spec || "(no spec yet)",
  ].join("\n");
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

  const result = await run({
    cwd: resolveTaskCwd(db, taskId),
    role: "questioner",
    prompt: buildQuestionerPrompt(readSpec(taskId), { title: task.title }),
    permissionMode: "plan",
  });

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
 * Record answers to a task's Q&A. Answered questions are appended to the context
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
    if (a != null && a !== "" && !(Array.isArray(a) && a.length === 0)) {
      appendContext(taskId, `Q: ${q.text}\nA: ${fmtAnswer(a)}`);
    }
  }

  const allAnswered = qa.questions.every((q) => {
    const a = merged[q.id];
    return a != null && a !== "" && !(Array.isArray(a) && a.length === 0);
  });
  const status = allAnswered && qa.questions.length > 0 ? "ready" : "needs_feedback";
  updateTask(db, taskId, { status });
  return { status };
}
