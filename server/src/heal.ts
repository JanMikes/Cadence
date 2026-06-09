import type { ActivityTracker } from "./activity";
import { runDiscovery } from "./agents/discovery";
import { runQuestioner } from "./agents/questioner";
import type { AgentRunner } from "./agents/triage";
import type { Db } from "./db/client";
import { listTasks } from "./tasks";
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
 */
export async function healStuckTasks(deps: HealDeps): Promise<number> {
  const { db, runAgent, activity, hub } = deps;
  const stuck = listTasks(db, { status: "refining" });
  let healed = 0;
  for (const task of stuck) {
    if (activity.isActive(task.id)) continue;
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
