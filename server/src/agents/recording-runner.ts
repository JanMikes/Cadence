import type { AgentResult, ClaudeEvent } from "@cadence/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";
import { getTask } from "../tasks";
import { findTranscriptPath, transcriptPathFor } from "../transcripts";
import type { WsHub } from "../ws";
import { type AgentRunOptions, modelForRole, runAgent } from "./runner";
import { assertStageIdle } from "./stage-guard";
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
    const projectId = getTask(db, opts.taskId)?.projectId ?? null;

    // In-flight dedupe (§6.1.b, the runaway-discovery fix): every task-linked stage run
    // passes through here, so this one check covers capture, heal, /refine, PLAY and the
    // execution chain. Throws when an honestly-alive run of the same (task, role) exists;
    // finalizes stale zombie rows as a side effect. Synchronous from check to insert below,
    // so in-process callers cannot interleave past it.
    assertStageIdle(db, opts.taskId, role);

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
          model: opts.model ?? modelForRole(role) ?? null,
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
      return base({ ...opts, sessionId: id });
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
      // A run that errored or produced no parseable output is a failure worth seeing —
      // the transcript still exists, and that's exactly when you want to read it.
      const ok = !result.isError && (result.text.trim() !== "" || result.json != null);
      finish({ status: ok ? "done" : "failed", costUsd: result.costUsd });
      return result;
    } catch (err) {
      finish({ status: "failed" });
      throw err;
    }
  };
}
