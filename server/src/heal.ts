import type { ActivityTracker } from "./activity";
import { runDiscovery } from "./agents/discovery";
import { countRecentStageRuns, findLiveStage } from "./agents/stage-guard";
import { runQuestioner } from "./agents/questioner";
import type { AgentRunner } from "./agents/triage";
import type { Db } from "./db/client";
import { notifyOnTransition } from "./notify";
import { opsSettings } from "./ops";
import { appendContext } from "./store/store";
import { listTasks, updateTask } from "./tasks";
import type { WsHub } from "./ws";

export interface HealDeps {
  db: Db;
  runAgent: AgentRunner;
  activity: ActivityTracker;
  hub: WsHub;
}

/**
 * Re-run refinement on tasks left in "refining" by a previous (crashed / restarted / stuck) run.
 * Discovery + the Questioner are now robust (they never strand a task), so each one moves to Ready or
 * Needs-Feedback. Sequential to avoid a thundering herd of agent spawns; activity-tracked so the board
 * shows a spinner while it heals. Skips tasks already being worked.
 *
 * Execution-side strands (tasks left in "implementing"/"verifying" by a dead run) and orphaned
 * sessions are handled separately by reconcileOrphans/the session watchdog (see watchdog.ts).
 */
export async function healStuckTasks(deps: HealDeps): Promise<number> {
  const { db, runAgent, activity, hub } = deps;
  const stuck = listTasks(db, { status: "refining" });
  let healed = 0;
  for (const task of stuck) {
    if (activity.isActive(task.id)) continue;
    // A discovery from a previous gateway life may still be genuinely alive (one-shots
    // can outlive a restart) — never duplicate it. Stale zombie rows are finalized by
    // the check itself, so they don't block healing. (§6.1.b)
    if (findLiveStage(db, task.id, "discovery")) continue;
    // Circuit breaker (§6.1.c): autonomy gets a bounded number of automatic attempts;
    // past that the task needs a human, not another agent — flip it to Needs-Feedback
    // loudly (note + notification) instead of silently spawning money. The budget is a
    // live Settings knob (§6.3.e).
    const budget = opsSettings().maxStageAttemptsPer24h;
    if (countRecentStageRuns(db, task.id, "discovery") >= budget) {
      const halted = updateTask(db, task.id, { status: "needs_feedback" });
      appendContext(
        task.id,
        `Automatic refinement halted after ${budget} attempts in 24h — ` +
          "Cadence won't spawn more agents for this task until you add input " +
          "(answer / add context, then run Refine).",
      );
      if (halted) notifyOnTransition(hub, "refining", halted);
      hub.broadcast({ type: "event", name: "task:updated", payload: task.id });
      continue;
    }
    try {
      const disc = await activity.track(task.id, "discovery", () => runDiscovery(db, task.id, runAgent));
      hub.broadcast({ type: "event", name: "task:updated", payload: task.id });
      if (disc.status === "refining") {
        await activity.track(task.id, "questioner", () => runQuestioner(db, task.id, runAgent));
        hub.broadcast({ type: "event", name: "task:updated", payload: task.id });
      }
      healed += 1;
    } catch (err) {
      console.error(`[cadence] self-heal failed for ${task.id}:`, err);
    }
  }
  return healed;
}
