/**
 * Tracks which tasks an autonomy agent is actively working (triage / discovery / questioner / refine),
 * so the UI can show a "work in progress" spinner on the board and task. In-memory and broadcast over
 * WS; cleared on restart (the startup self-heal re-runs anything that was mid-flight).
 */
export type AgentStage = "triage" | "discovery" | "questioner" | "refine" | (string & {});

export interface ActivityEntry {
  taskId: string;
  stage: AgentStage;
  startedAt: number;
}

type Broadcast = (name: "activity:start" | "activity:end", payload: { taskId: string; stage?: AgentStage }) => void;

export class ActivityTracker {
  private readonly active = new Map<string, ActivityEntry>();

  constructor(
    private readonly broadcast: Broadcast,
    private readonly now: () => number = Date.now,
  ) {}

  start(taskId: string, stage: AgentStage): void {
    this.active.set(taskId, { taskId, stage, startedAt: this.now() });
    this.broadcast("activity:start", { taskId, stage });
  }

  end(taskId: string): void {
    if (this.active.delete(taskId)) this.broadcast("activity:end", { taskId });
  }

  /** Mark `taskId` busy with `stage` while `fn` runs — starts before, ends after (even if it throws). */
  async track<T>(taskId: string, stage: AgentStage, fn: () => Promise<T>): Promise<T> {
    this.start(taskId, stage);
    try {
      return await fn();
    } finally {
      this.end(taskId);
    }
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** Snapshot of in-progress work — served at GET /api/activity so a fresh page load hydrates. */
  list(): ActivityEntry[] {
    return [...this.active.values()];
  }
}
