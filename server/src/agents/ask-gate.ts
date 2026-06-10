import type { ApprovalDecision } from "@cadence/shared";
import type { ApprovalRegistry } from "../approvals";
import type { Db } from "../db/client";
import { opsSettings } from "../ops";
import { appendContext, readQa, writeQa } from "../store/store";
import { getTask } from "../tasks";
import type { WsHub } from "../ws";
import { qaQuestionsFromAsks, roleNoun } from "./interactive";

/**
 * The ask-gate: turns an in-flight `canUseTool` interception into a thing the user
 * can act on in the web UI, while the run stays alive and waits. This is the hard
 * guarantee the prompt contract can't give — every interactive tool call passes
 * through the permission layer no matter what any prompt says.
 *
 * Flow: park the request in the ApprovalRegistry (→ `approval:requested` WS event →
 * top-urgency attention item + modal) + fire a notification → wait up to
 * `askWaitMinutes` (the runner pauses its stage clock meanwhile) → either feed the
 * user's answers back into the run, or time out and let the agent proceed on stated
 * assumptions. Answered questions are persisted to the task's Q&A channel so the
 * record survives the run.
 */

export interface AskContext {
  taskId?: string | null;
  sessionId?: string | null;
  role?: string;
  /** The run was aborted (stop/kill) — stop waiting immediately. */
  signal?: AbortSignal;
}

export interface AskGate {
  /** Park an AskUserQuestion payload; resolves with answers or null (timeout/denied). */
  askQuestions(input: unknown, ctx: AskContext): Promise<Record<string, string | string[]> | null>;
  /** Park a generic tool-permission request (Manual mode); resolves allow/deny. */
  approveTool(toolName: string, input: unknown, ctx: AskContext): Promise<boolean>;
  /** How many asks are currently parked (the runner pauses its stage clock while > 0). */
  pendingCount(): number;
}

export interface AskGateDeps {
  approvals: ApprovalRegistry;
  hub: WsHub;
  db: Db;
  /** Override the wait window (tests); default = ops askWaitMinutes. */
  waitMsOverride?: number;
}

/** Shape of the AskUserQuestion tool input (kept permissive). */
interface AskInput {
  questions?: Array<{ question?: string }>;
}

export function makeAskGate(deps: AskGateDeps): AskGate {
  const { approvals, hub, db } = deps;
  let pending = 0;

  const waitMs = (): number => deps.waitMsOverride ?? opsSettings().askWaitMinutes * 60_000;

  /** Park in the registry and race the user against the wait window / an abort. */
  const park = async (
    toolName: string,
    input: unknown,
    ctx: AskContext,
  ): Promise<ApprovalDecision | null> => {
    const id = crypto.randomUUID();
    pending += 1;
    try {
      const decision = approvals.request(
        { sessionId: ctx.sessionId, taskId: ctx.taskId, toolName, input, role: ctx.role ?? null },
        { id },
      );
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onAbort: (() => void) | null = null;
      const giveUp = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          // Withdraw the parked card so the UI never shows a stale ask for a run
          // that has already moved on (display-logic rule: no dead controls).
          approvals.resolve(id, { allow: false, reason: "timed out — nobody answered" });
          resolve(null);
        }, waitMs());
        if (typeof timer.unref === "function") timer.unref();
        if (ctx.signal) {
          onAbort = () => {
            approvals.resolve(id, { allow: false, reason: "run was stopped" });
            resolve(null);
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const result = await Promise.race([decision, giveUp]);
      if (timer) clearTimeout(timer);
      if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      return result;
    } finally {
      pending -= 1;
    }
  };

  const notify = (ctx: AskContext, message: string): void => {
    const label = roleNoun(ctx.role ?? "agent");
    const title = `${label[0]?.toUpperCase()}${label.slice(1)} is asking — run paused`;
    hub.broadcast({
      type: "event",
      name: "notify",
      payload: {
        kind: "needs_feedback",
        title,
        message,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      },
    });
  };

  /** Persist an answered live Q&A onto the task (qa.md + context channel). */
  const recordAnswers = (
    ctx: AskContext,
    input: unknown,
    answers: Record<string, string | string[]>,
  ): void => {
    if (!ctx.taskId || !getTask(db, ctx.taskId)) return;
    try {
      const qa = readQa(ctx.taskId);
      const fresh = qaQuestionsFromAsks(
        [{ tool: "AskUserQuestion", toolUseId: null, input }],
        qa.questions,
      );
      const merged = { ...qa.answers };
      for (const q of fresh) {
        const a = answers[q.text];
        if (a != null) merged[q.id] = a;
      }
      writeQa(ctx.taskId, { questions: [...qa.questions, ...fresh], answers: merged });
      for (const [q, a] of Object.entries(answers)) {
        appendContext(ctx.taskId, `Q: ${q}\nA: ${Array.isArray(a) ? a.join(", ") : a}`);
      }
      hub.broadcast({ type: "event", name: "task:context", payload: ctx.taskId });
    } catch (err) {
      console.warn(`[cadence] could not record live answers for ${ctx.taskId}:`, (err as Error).message);
    }
  };

  return {
    pendingCount: () => pending,

    async askQuestions(input, ctx) {
      const first = ((input ?? {}) as AskInput).questions?.[0]?.question ?? "an agent question";
      notify(ctx, first);
      const decision = await park("AskUserQuestion", input, ctx);
      const answers = decision?.allow && decision.answers ? decision.answers : null;
      if (answers && Object.keys(answers).length > 0) {
        recordAnswers(ctx, input, answers);
        return answers;
      }
      return null;
    },

    async approveTool(toolName, input, ctx) {
      notify(ctx, `Allow ${toolName}?`);
      const decision = await park(toolName, input, ctx);
      return decision?.allow === true;
    },
  };
}
