import type { AgentResult, ClaudeEvent } from "@cadence/shared";
import { eq } from "drizzle-orm";
import { composeContext } from "../context";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";
import { getProjectById } from "../projects";
import { appendContext, appendRunReport } from "../store/store";
import { getTask } from "../tasks";
import { findTranscriptPath, transcriptPathFor } from "../transcripts";
import type { WsHub } from "../ws";
import { applyInteractiveAsks, describeAsks } from "./interactive";
import { getAgentModel, projectPromptLayer } from "./prompts";
import { type AgentRunOptions, runAgent } from "./runner";
import { assertConcurrencyCapacity, assertStageIdle } from "./stage-guard";
import type { AgentRunner } from "./triage";

export interface RecordingRunnerDeps {
  db: Db;
  hub: WsHub;
  /** The underlying one-shot runner (injectable for tests; default real claude). */
  base?: AgentRunner;
}

/**
 * Wrap the one-shot runner so every task-linked agent stage becomes a first-class
 * Session (kind:"oneshot") pointing at the transcript claude writes on disk — each
 * triage/discovery/questioner/planner/implementer/verifier/delivery run then shows
 * up in the Sessions list with its full output, status, and cost (the deep version
 * of the activity spinner). Runs without a taskId (or resumes) pass straight through
 * unrecorded, so this is purely additive and never breaks the pipeline.
 */
export function makeRecordingRunner(deps: RecordingRunnerDeps): AgentRunner {
  const { db, hub } = deps;
  const base = deps.base ?? runAgent;

  return async (opts: AgentRunOptions): Promise<AgentResult> => {
    // Record only fresh, task-linked runs. (A resume reuses an existing session/transcript.)
    if (!opts.taskId || opts.resumeSessionId) return base(opts);

    const id = crypto.randomUUID();
    const role = opts.role ?? "agent";
    const task = getTask(db, opts.taskId);
    const projectId = task?.projectId ?? null;

    // Layered context (§6.3.f — the "compose into every agent run" locked decision):
    // one-shot stages receive the global→project→fleet→task layers via
    // --append-system-prompt, exactly like warm chats. An explicit caller value wins;
    // composition failure must never break a spawn.
    let appendSystemPrompt = opts.appendSystemPrompt;
    if (appendSystemPrompt == null) {
      try {
        appendSystemPrompt =
          composeContext(db, {
            taskId: opts.taskId,
            projectId,
            fleetId: task?.fleetId ?? null,
          }) || undefined;
      } catch (err) {
        console.warn(`[cadence] context composition skipped for ${role}:`, (err as Error).message);
      }
    }

    // Project agent-prompt layer (§6.3.b): the project's per-role addition is appended to
    // the rendered global prompt (override ?? default) — the layers compose, like the
    // context layers above. Lookup failure must never break a spawn.
    let prompt = opts.prompt;
    try {
      const layer = projectPromptLayer(projectId ? getProjectById(db, projectId) : null, role);
      if (layer) prompt = `${prompt}\n\n${layer}`;
    } catch (err) {
      console.warn(`[cadence] project prompt layer skipped for ${role}:`, (err as Error).message);
    }

    // In-flight dedupe (§6.1.b, the runaway-discovery fix): every task-linked stage run
    // passes through here, so this one check covers capture, heal, /refine, PLAY and the
    // execution chain. Throws when an honestly-alive run of the same (task, role) exists;
    // finalizes stale zombie rows as a side effect. Synchronous from check to insert below,
    // so in-process callers cannot interleave past it.
    assertStageIdle(db, opts.taskId, role);
    // Global money valve (§6.3.e): never exceed the concurrent-agent cap.
    assertConcurrencyCapacity(db);

    try {
      db.insert(sessions)
        .values({
          id,
          taskId: opts.taskId,
          projectId,
          role,
          kind: "oneshot",
          status: "running",
          cwd: opts.cwd,
          model: opts.model ?? getAgentModel(role) ?? null,
          permissionMode: opts.permissionMode ?? null,
          costUsd: 0,
          startedAt: Date.now(),
          // claude writes the transcript here because we pass --session-id below.
          transcriptPath: transcriptPathFor(opts.cwd, id),
        })
        .run();
      hub.broadcast({ type: "event", name: "session:spawned", payload: id });
    } catch (err) {
      // Recording must never break the pipeline — if the insert fails, just run plainly.
      console.warn(`[cadence] could not record ${role} session:`, (err as Error).message);
      return base({ ...opts, prompt, sessionId: id });
    }

    const update = (patch: Partial<typeof sessions.$inferInsert>): void => {
      try {
        db.update(sessions).set(patch).where(eq(sessions.id, id)).run();
      } catch (err) {
        console.warn(`[cadence] session ${id} update skipped:`, (err as Error).message);
      }
    };

    const finish = (patch: Partial<typeof sessions.$inferInsert>): void => {
      // Self-heal the transcript pointer: if claude wrote the file somewhere else than
      // our guess (encoding drift), relink it so History/search/watchdog all find it.
      const onDisk = findTranscriptPath(id, opts.cwd);
      update({
        ...patch,
        endedAt: Date.now(),
        ...(onDisk ? { transcriptPath: onDisk } : {}),
      });
      hub.broadcast({ type: "event", name: "session:updated", payload: id });
    };

    try {
      const result = await base({
        ...opts,
        prompt,
        appendSystemPrompt,
        sessionId: id,
        // Track the child pid so liveness ("is this run actually alive?"), Stop/Kill and
        // the watchdog work for pipeline runs — not just warm chats.
        onSpawn: (pid) => {
          opts.onSpawn?.(pid);
          update({ pid });
          hub.broadcast({ type: "event", name: "session:updated", payload: id });
        },
        // Forward every stream-json event to the web clients — the same contract warm
        // sessions use — so an open Session view streams this run live, token by token.
        onEvent: (event: ClaudeEvent) => {
          opts.onEvent?.(event);
          hub.broadcast({ type: "event", name: "session:event", payload: { sessionId: id, event } });
        },
      });
      // Success first: a run that delivered usable output stands, even if a question
      // went unanswered along the way (SDK ask-gate timeout → the agent proceeded on
      // stated assumptions). Only a run that produced NOTHING usable becomes a handoff:
      // its asks turn into Q&A cards + Needs-input + a context note (§10, never a dead
      // end) — exactly how the Questioner's own questions surface.
      const produced = !result.isError && (result.text.trim() !== "" || result.json != null);
      const askedUser = !produced && (result.asks?.length ?? 0) > 0;
      if (askedUser) {
        applyInteractiveAsks(db, hub, opts.taskId, role, result.asks ?? []);
        // The contract stage code keys on (see AgentResult.askParked): only set when
        // the park actually happened — `asks` alone never implies a status change.
        result.askParked = true;
      } else if (produced && result.asks?.length) {
        // The run recovered after an unanswered ask — keep the record honest without
        // derailing the pipeline: the user can still weigh in at the next gate.
        appendContext(
          opts.taskId,
          `While you were away, ${role} ${describeAsks(result.asks)} — no answer arrived, so it proceeded on its own assumptions. Review its output with that in mind.`,
        );
        hub.broadcast({ type: "event", name: "task:context", payload: opts.taskId });
      }
      // A run that errored or produced no parseable output is a failure worth seeing —
      // the transcript still exists, and that's exactly when you want to read it.
      const ok = produced;
      finish({ status: askedUser ? "awaiting_feedback" : ok ? "done" : "failed", costUsd: result.costUsd });
      // Durable account of what this stage said/did (runs.md — content truth): the
      // final text, the structured JSON, the ask that stopped it, or the error detail —
      // never a bare "(no output)".
      appendRunReport(opts.taskId, {
        at: Date.now(),
        role,
        status: askedUser ? "needs_input" : ok ? "done" : "failed",
        costUsd: result.costUsd ?? null,
        sessionId: id,
        model: opts.model ?? getAgentModel(role) ?? null,
        output: askedUser
          ? `Stopped to ask for your input — the agent ${describeAsks(result.asks ?? [])}. Any questions were added to this task's Q&A; answer them and run the stage again.`
          : result.text.trim() ||
            (result.json != null
              ? JSON.stringify(result.json, null, 2)
              : result.errorDetail
                ? `The run failed before producing output: ${result.errorDetail}`
                : ""),
      });
      return result;
    } catch (err) {
      finish({ status: "failed" });
      appendRunReport(opts.taskId, {
        at: Date.now(),
        role,
        status: "failed",
        costUsd: null,
        sessionId: id,
        model: opts.model ?? getAgentModel(role) ?? null,
        output: `Run crashed before finishing: ${(err as Error).message}`,
      });
      throw err;
    }
  };
}
