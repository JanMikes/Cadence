import type { InteractiveAsk, QAQuestion } from "@cadence/shared";
import type { Db } from "../db/client";
import { appendContext, readQa, writeQa } from "../store/store";
import { getTask, updateTask } from "../tasks";
import type { WsHub } from "../ws";

/**
 * What happens when a one-shot agent asks for a human (§10: never a silent dead end).
 * The runner stops such a run and hands back the structured asks; this module turns
 * them into the things Cadence already knows how to surface — Q&A cards, a context
 * note, the Needs-input state, and a notification — so "Claude asked a question"
 * looks exactly like the Questioner asking, never like a mystery failure.
 */

/** The AskUserQuestion tool input (verified shape, binary v2.1.x). Kept permissive. */
interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string } | string>;
  }>;
}

/** Human name for a pipeline role, for notes/notifications. */
export function roleNoun(role: string): string {
  return (
    {
      triage: "Triage",
      discovery: "Discovery",
      questioner: "the Questioner",
      planner: "the Planner",
      implementer: "the Implementer",
      verifier: "the Verifier",
      delivery: "Delivery",
      reviewer: "the Reviewer",
      review_responder: "the Review responder",
    }[role] ?? `the ${role} agent`
  );
}

/**
 * Convert AskUserQuestion payloads into Q&A cards. Ids never collide with the
 * existing channel (answers are keyed by id), ranks continue after it.
 */
export function qaQuestionsFromAsks(asks: InteractiveAsk[], existing: QAQuestion[]): QAQuestion[] {
  const out: QAQuestion[] = [];
  const taken = new Set(existing.map((q) => q.id));
  let n = existing.length;
  for (const ask of asks) {
    if (ask.tool !== "AskUserQuestion") continue;
    const input = (ask.input ?? null) as AskUserQuestionInput | null;
    for (const q of input?.questions ?? []) {
      const text = (q?.question ?? "").trim();
      if (!text) continue;
      n += 1;
      let id = `ask${n}`;
      while (taken.has(id)) id = `ask${++n}`;
      taken.add(id);
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => (typeof o === "string" ? o : (o?.label ?? "")).trim())
        .filter(Boolean);
      const question: QAQuestion = {
        id,
        rank: n,
        type: options.length ? (q.multiSelect ? "multi_choice" : "single_choice") : "text",
        text,
      };
      if (options.length) question.options = options;
      if (q.header?.trim()) question.why = q.header.trim();
      out.push(question);
    }
  }
  return out;
}

/** One readable sentence fragment per ask — for context notes and run reports. */
export function describeAsks(asks: InteractiveAsk[]): string {
  return asks
    .map((a) => {
      if (a.tool === "AskUserQuestion") {
        const qs = (((a.input ?? null) as AskUserQuestionInput | null)?.questions ?? [])
          .map((q) => (q?.question ?? "").trim())
          .filter(Boolean)
          .map((q) => `“${q}”`)
          .join("; ");
        return qs ? `asked: ${qs}` : "asked a question";
      }
      if (a.tool === "ExitPlanMode") {
        return "tried to hand over an interactive plan (ExitPlanMode) instead of printing its result";
      }
      return `called ${a.tool}, which needs a human to respond`;
    })
    .join("; ");
}

/**
 * Apply a run's interactive asks to the task: merge any questions into qa.md,
 * note what happened on the context channel, park the task in Needs-input, and
 * notify. Total — must never throw (it runs inside the recording wrapper).
 */
export function applyInteractiveAsks(
  db: Db,
  hub: WsHub,
  taskId: string,
  role: string,
  asks: InteractiveAsk[],
): void {
  try {
    const label = roleNoun(role);
    const qa = readQa(taskId);
    const fresh = qaQuestionsFromAsks(asks, qa.questions);
    if (fresh.length) {
      writeQa(taskId, { questions: [...qa.questions, ...fresh], answers: qa.answers });
    }
    appendContext(
      taskId,
      fresh.length
        ? `${label} stopped because it needs your input — it ${describeAsks(asks)}. Answer the questions on this task; your answers feed the next run.`
        : `${label} stopped because it ${describeAsks(asks)} — an unattended run has nobody to respond. Add the missing context (or adjust the task) and run the stage again.`,
    );
    const before = getTask(db, taskId)?.status;
    const updated = updateTask(db, taskId, { status: "needs_feedback" });
    hub.broadcast({ type: "event", name: "task:context", payload: taskId });
    hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    if (updated && before !== "needs_feedback") {
      hub.broadcast({
        type: "event",
        name: "notify",
        payload: {
          kind: "needs_feedback",
          title: `${label[0]?.toUpperCase()}${label.slice(1)} needs your input`,
          message: updated.title,
          taskId,
        },
      });
    }
  } catch (err) {
    console.warn(`[cadence] could not surface interactive ask for ${taskId}:`, (err as Error).message);
  }
}
