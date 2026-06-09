/**
 * Tracks which tasks an autonomy agent is actively working (triage / discovery / questioner /
 * implementer / …), so the UI can show a "work in progress" spinner on the board and task.
 * In-memory and broadcast over WS; cleared on restart (the startup self-heal re-runs anything
 * that was mid-flight).
 *
 * Keyed per (task, stage) — §6.1.f: with a single taskId key, a second concurrent stage
 * overwrote the first and the first `end()` deleted the survivor's entry, corrupting both the
 * spinner and every `isActive` guard built on it.
 */
export type AgentStage = "triage" | "discovery" | "questioner" | "refine" | (string & {});

export interface ActivityEntry {
  taskId: string;
  stage: AgentStage;
  startedAt: number;
}

type Broadcast = (
  name: "activity:start" | "activity:end",
  payload: { taskId: string; stage?: AgentStage; next?: AgentStage | null },
) => void;

export class ActivityTracker {
  /** taskId → in-flight stages, oldest first (a task may run several at once). */
  private readonly active = new Map<string, ActivityEntry[]>();

  constructor(
    private readonly broadcast: Broadcast,
    private readonly now: () => number = Date.now,
  ) {}

  start(taskId: string, stage: AgentStage): void {
    const list = this.active.get(taskId) ?? [];
    list.push({ taskId, stage, startedAt: this.now() });
    this.active.set(taskId, list);
    this.broadcast("activity:start", { taskId, stage });
  }

  /**
   * End the newest entry of `stage` for the task (other concurrent stages keep running).
   * The event carries `next` — the stage still working the task, if any — so the UI
   * spinner can fall back to it instead of going dark while work continues.
   */
  end(taskId: string, stage?: AgentStage): void {
    const list = this.active.get(taskId);
    if (!list?.length) return;
    const idx = stage != null ? list.findLastIndex((e) => e.stage === stage) : list.length - 1;
    if (idx < 0) return;
    const [removed] = list.splice(idx, 1);
    if (list.length === 0) this.active.delete(taskId);
    this.broadcast("activity:end", {
      taskId,
      stage: removed?.stage,
      next: list.at(-1)?.stage ?? null,
    });
  }

  /** Mark `taskId` busy with `stage` while `fn` runs — starts before, ends after (even if it throws). */
  async track<T>(taskId: string, stage: AgentStage, fn: () => Promise<T>): Promise<T> {
    this.start(taskId, stage);
    try {
      return await fn();
    } finally {
      this.end(taskId, stage);
    }
  }

  isActive(taskId: string): boolean {
    return (this.active.get(taskId)?.length ?? 0) > 0;
  }

  /** Snapshot of in-progress work — served at GET /api/activity so a fresh page load hydrates. */
  list(): ActivityEntry[] {
    return [...this.active.values()].flat();
  }
}
