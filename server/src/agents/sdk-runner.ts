import type { AgentResult, ClaudeEvent, InteractiveAsk } from "@cadence/shared";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { claudeSubprocessEnv } from "../claude-env";
import { registerInProcessRun, unregisterInProcessRun } from "../liveness";
import type { AskGate } from "./ask-gate";
import { getAgentModel } from "./prompts";
import { type AgentRunOptions, defaultStageTimeoutMs, parseAgentJson } from "./runner";

/**
 * The Agent-SDK one-shot runner (interaction-handling Part B): same contract as the
 * CLI runner, but interactive asks are HELD instead of dead-ending — `canUseTool`
 * sits in the tool-call path itself (a hard guarantee no prompt wording can give),
 * routes the ask to the web UI via the ask-gate, and feeds the answer back so the
 * run continues alive. Message shapes match `claude -p --output-format stream-json`
 * 1:1, so every existing consumer (live transcript, recording, watchdog) just works.
 */

/** Reworded contract for SDK runs: questions are ALLOWED here — they reach the user. */
export const SDK_RUN_CONTRACT =
  "UNATTENDED RUN with a live question channel: if you need a decision you cannot make " +
  "yourself, use the AskUserQuestion tool — the user may answer in real time. Ask at most " +
  "once, batching every question into that single call. If it is denied or unanswered, " +
  "proceed with reasonable assumptions and state them explicitly in your final output. " +
  "Never use ExitPlanMode; print your final answer as your last message in the response " +
  "format your instructions define.";

type QueryFn = typeof sdkQuery;

/** The SDK could not run at all (no event ever arrived) — callers fall back to the CLI. */
export class SdkUnavailableError extends Error {}

export interface SdkRunnerDeps {
  askGate?: AskGate;
  /** Injectable query (tests run a fake generator; default = the real SDK). */
  queryFn?: QueryFn;
}

/** AskUserQuestion input → updatedInput with the user's answers (verified contract). */
function answeredInput(
  input: Record<string, unknown>,
  answers: Record<string, string | string[]>,
): Record<string, unknown> {
  return { questions: input.questions, answers };
}

export function makeSdkRunner(deps: SdkRunnerDeps = {}): (opts: AgentRunOptions) => Promise<AgentResult> {
  const query = deps.queryFn ?? sdkQuery;

  return async function runAgentSdk(opts: AgentRunOptions): Promise<AgentResult> {
    const askGate = deps.askGate;
    const abort = new AbortController();
    const asks: InteractiveAsk[] = [];
    const seenAskIds = new Set<string>();
    const recordAsk = (tool: string, toolUseId: string | null, input: unknown): void => {
      if (toolUseId && seenAskIds.has(toolUseId)) return;
      if (toolUseId) seenAskIds.add(toolUseId);
      asks.push({ tool, toolUseId, input });
    };

    const model = opts.model ?? getAgentModel(opts.role);
    const permissionMode = opts.permissionMode ?? "plan";
    const appendSystemPrompt = opts.appendSystemPrompt
      ? `${opts.appendSystemPrompt}\n\n${SDK_RUN_CONTRACT}`
      : SDK_RUN_CONTRACT;

    let agents: Record<string, unknown> | undefined;
    if (opts.agentsJson) {
      try {
        agents = JSON.parse(opts.agentsJson) as Record<string, unknown>;
      } catch {
        console.warn(`[cadence] invalid agents JSON for ${opts.role ?? "?"} — running without subagents`);
      }
    }

    const ctx = { taskId: opts.taskId, sessionId: opts.sessionId, role: opts.role, signal: abort.signal };

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID: string },
    ): Promise<
      | { behavior: "allow"; updatedInput: Record<string, unknown> }
      | { behavior: "deny"; message: string }
    > => {
      if (toolName === "AskUserQuestion") {
        const answers = askGate ? await askGate.askQuestions(input, ctx) : null;
        if (answers) return { behavior: "allow", updatedInput: answeredInput(input, answers) };
        // Unanswered: record the ask (it surfaces as Q&A cards if the run can't
        // recover) and tell the model how to proceed instead of leaving it confused.
        recordAsk(toolName, options.toolUseID, input);
        return {
          behavior: "deny",
          message:
            "No answer arrived. Proceed with the most reasonable assumption for each question " +
            "and state your assumptions explicitly in your final output.",
        };
      }
      if (toolName === "ExitPlanMode") {
        recordAsk(toolName, options.toolUseID, input);
        return {
          behavior: "deny",
          message:
            "This is a non-interactive pipeline run — do not exit plan mode. Print your final " +
            "answer as plain text in the response format your instructions define, then stop.",
        };
      }
      // Any other permission-gated tool: under Manual mode ("default") the whole point
      // is a human decision — park it in the approval UI. Other modes behave like the
      // CLI (deny with a reason), but the denial is RECORDED, never silent.
      if (permissionMode === "default" && askGate) {
        const allowed = await askGate.approveTool(toolName, input, ctx);
        if (allowed) return { behavior: "allow", updatedInput: input };
        recordAsk(toolName, options.toolUseID, input);
        return { behavior: "deny", message: "The user declined this action (or wasn't around to approve it)." };
      }
      recordAsk(toolName, options.toolUseID, input);
      return {
        behavior: "deny",
        message: `${toolName} is not permitted in this unattended ${opts.role ?? "agent"} stage. Work within your allowed tools.`,
      };
    };

    // Stage ceiling with a PAUSED clock while an ask waits on the user — a question
    // must never eat the run's own budget. Checked coarsely (5s) which is plenty.
    const timeoutMs = opts.timeoutMs ?? defaultStageTimeoutMs(opts.role);
    const startedAt = Date.now();
    let waitedMs = 0;
    let lastTick = startedAt;
    let timedOut = false;
    const ticker = timeoutMs
      ? setInterval(() => {
          const now = Date.now();
          if ((askGate?.pendingCount() ?? 0) > 0) waitedMs += now - lastTick;
          lastTick = now;
          if (now - startedAt - waitedMs > timeoutMs) {
            timedOut = true;
            abort.abort();
          }
        }, 5_000)
      : null;
    if (ticker && typeof ticker.unref === "function") ticker.unref();

    let stopped = false; // user-initiated stop — distinct from timeout and from SDK failure
    if (opts.sessionId) {
      registerInProcessRun(opts.sessionId, () => {
        stopped = true;
        abort.abort();
      });
    }
    opts.onSpawn?.(null); // the SDK owns the child; liveness rides the in-process registry

    let last: Record<string, unknown> | null = null;
    let errorDetail: string | null = null;
    try {
      const q = query({
        prompt: opts.prompt,
        options: {
          cwd: opts.cwd,
          permissionMode: permissionMode as never,
          ...(model ? { model } : {}),
          // The claude_code preset + our layered append — same net behavior as the
          // CLI's --append-system-prompt.
          systemPrompt: { type: "preset", preset: "claude_code", append: appendSystemPrompt },
          ...(opts.resumeSessionId
            ? { resume: opts.resumeSessionId }
            : opts.sessionId
              ? { sessionId: opts.sessionId }
              : {}),
          ...(agents ? { agents: agents as never } : {}),
          includePartialMessages: true,
          canUseTool: canUseTool as never,
          abortController: abort,
          // Subscription guard: Options.env REPLACES the subprocess env, so this is
          // the full inherited env minus any stray ANTHROPIC_API_KEY (claude-env.ts).
          env: claudeSubprocessEnv(),
          // bypassPermissions (worktree implementer) requires the explicit opt-in flag.
          ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        },
      });
      for await (const msg of q) {
        const ev = msg as unknown as Record<string, unknown>;
        if (ev && typeof ev.type === "string") {
          opts.onEvent?.(ev as ClaudeEvent);
          if (ev.type === "result" || last == null || last.type !== "result") last = ev;
          if (ev.type === "result") {
            // Name-agnostic catch-all (same contract as the CLI runner): every denied
            // tool — including ones we've never heard of — lands here.
            const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
            for (const d of denials as Array<Record<string, unknown>>) {
              recordAsk(
                String(d?.tool_name ?? "unknown"),
                typeof d?.tool_use_id === "string" ? d.tool_use_id : null,
                d?.tool_input ?? null,
              );
            }
          }
        }
      }
    } catch (err) {
      // Abort (timeout/stop) or SDK failure — never throw past here; the result
      // carries the diagnosis (never-silent contract).
      errorDetail = timedOut ? "agent timed out" : (err as Error).message;
    } finally {
      if (ticker) clearInterval(ticker);
      if (opts.sessionId) unregisterInProcessRun(opts.sessionId);
    }

    if (timedOut) {
      // Preserve the CLI runner's contract: a hard stage timeout REJECTS (callers
      // treat it as a crashed run and run their recovery).
      throw new Error("agent timed out");
    }
    if (errorDetail && last == null && !stopped) {
      // Nothing ever arrived — the SDK/bundled binary couldn't start. Let the
      // dispatcher retry on the CLI runner instead of reporting a phantom failure.
      throw new SdkUnavailableError(errorDetail);
    }
    if (stopped && !errorDetail) errorDetail = "run was stopped";

    const obj = last ?? {};
    const text = typeof obj.result === "string" ? obj.result : "";
    const result: AgentResult = {
      text,
      json: parseAgentJson(text),
      costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
      sessionId: typeof obj.session_id === "string" ? obj.session_id : (opts.sessionId ?? null),
      isError: obj.is_error === true || obj.subtype === "error",
      raw: last,
    };
    if (asks.length) result.asks = asks;
    if (errorDetail) result.errorDetail = errorDetail.slice(0, 1000);
    return result;
  };
}
