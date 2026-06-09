import type { ClaudeEvent, Session, UpdateSessionInput } from "@cadence/shared";
import { desc, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { sessions } from "./db/schema";
import { openSession, type SessionHandle } from "./spawn";
import { transcriptPathFor } from "./transcripts";
import type { WsHub } from "./ws";

/** Map a Cadence permission mode to a real claude --permission-mode (§9.1). */
export function claudePermissionMode(mode?: string): string {
  switch (mode) {
    case "dangerous":
      return "bypassPermissions";
    case "manual":
      return "default";
    case "auto":
      return "acceptEdits";
    default:
      return mode ?? "default"; // allow passing a raw claude mode through
  }
}

export function getSession(db: Db, id: string): Session | null {
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  return row ?? null;
}

export function listSessions(db: Db): Session[] {
  return db.select().from(sessions).orderBy(desc(sessions.startedAt)).all();
}

export function listTaskSessions(db: Db, taskId: string): Session[] {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(desc(sessions.startedAt))
    .all();
}

/** Sum of a task's session costs (an effort signal, not a budget — §10). */
export function taskCostUsd(db: Db, taskId: string): number {
  return listTaskSessions(db, taskId).reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
}

/**
 * Re-organize a session: (re)assign it to a task/project/fleet, or clear a link
 * (null). Index-only — sessions are runtime artifacts, so this is a pure DB write
 * (no markdown). Returns the updated row, or null if the session is gone.
 */
export function updateSession(db: Db, id: string, patch: UpdateSessionInput): Session | null {
  const set: Partial<typeof sessions.$inferInsert> = {};
  if ("taskId" in patch) set.taskId = patch.taskId ?? null;
  if ("projectId" in patch) set.projectId = patch.projectId ?? null;
  if ("fleetId" in patch) set.fleetId = patch.fleetId ?? null;
  if (Object.keys(set).length > 0) {
    db.update(sessions).set(set).where(eq(sessions.id, id)).run();
  }
  return getSession(db, id);
}

/** Drop a session row (its events cascade). Returns whether a row existed. */
export function deleteSession(db: Db, id: string): boolean {
  const existed = getSession(db, id) != null;
  db.delete(sessions).where(eq(sessions.id, id)).run();
  return existed;
}

export interface SpawnArgs {
  cwd: string;
  taskId?: string | null;
  projectId?: string | null;
  role?: string;
  model?: string;
  /** Cadence permission mode (auto|manual|dangerous). */
  permissionMode?: string;
  appendSystemPrompt?: string;
  /** Override the base command (tests pass ["bun", mockPath]). */
  command?: string[];
}

/**
 * Owns live warm sessions: spawns the claude process, records the session row,
 * accumulates cost from `result` events, forwards every event to WS clients, and
 * keeps the handle for follow-up sends (1.5) / close / kill.
 */
export class SpawnManager {
  private readonly handles = new Map<string, SessionHandle>();
  private latestRateLimitInfo: unknown = null;

  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
  ) {}

  /** The most recent rate_limit_info seen from a live session (5h/weekly windows). */
  latestRateLimit(): unknown {
    return this.latestRateLimitInfo;
  }

  spawn(args: SpawnArgs): Session {
    const id = crypto.randomUUID();
    const transcriptPath = transcriptPathFor(args.cwd, id);

    this.db
      .insert(sessions)
      .values({
        id,
        taskId: args.taskId ?? null,
        projectId: args.projectId ?? null,
        role: args.role ?? "chat",
        kind: "warm",
        status: "spawning",
        cwd: args.cwd,
        model: args.model ?? null,
        permissionMode: args.permissionMode ?? null,
        costUsd: 0,
        startedAt: Date.now(),
        transcriptPath,
      })
      .run();

    let cost = 0;
    const handle = openSession({
      sessionId: id,
      cwd: args.cwd,
      model: args.model,
      permissionMode: claudePermissionMode(args.permissionMode),
      appendSystemPrompt: args.appendSystemPrompt,
      command: args.command,
      onEvent: (event: ClaudeEvent) => {
        if (event.type === "system" && event.subtype === "init") {
          this.update(id, { status: "running" });
        }
        if (event.type === "result" && typeof event.total_cost_usd === "number") {
          cost += event.total_cost_usd;
          this.update(id, { costUsd: cost });
        }
        if (event.type === "rate_limit_event" || event.rate_limit_info != null) {
          this.latestRateLimitInfo = event.rate_limit_info ?? event;
        }
        this.hub.broadcast({ type: "event", name: "session:event", payload: { sessionId: id, event } });
      },
      onClose: (code) => {
        this.handles.delete(id);
        this.update(id, { status: code === 0 ? "done" : "failed", endedAt: Date.now() });
        this.hub.broadcast({ type: "event", name: "session:closed", payload: { sessionId: id, code } });
      },
      onError: (err) => {
        this.handles.delete(id);
        this.update(id, { status: "failed", endedAt: Date.now() });
        this.hub.broadcast({ type: "event", name: "session:error", payload: { sessionId: id, message: err.message } });
      },
    });

    this.handles.set(id, handle);
    this.update(id, { pid: handle.pid ?? null });

    const session = getSession(this.db, id);
    if (!session) throw new Error(`spawn: session ${id} missing after insert`);
    return session;
  }

  send(sessionId: string, text: string): boolean {
    const handle = this.handles.get(sessionId);
    handle?.send(text);
    return Boolean(handle);
  }

  close(sessionId: string): void {
    this.handles.get(sessionId)?.close();
  }

  kill(sessionId: string): void {
    this.handles.get(sessionId)?.kill();
  }

  /** Live (in-memory) session ids — for shutdown / status. */
  liveIds(): string[] {
    return [...this.handles.keys()];
  }

  private update(id: string, patch: Partial<typeof sessions.$inferInsert>): void {
    try {
      this.db.update(sessions).set(patch).where(eq(sessions.id, id)).run();
    } catch (err) {
      // A late event (e.g. process close during shutdown, after the db is gone)
      // shouldn't crash the manager.
      console.warn(`[cadence] session ${id} update skipped:`, (err as Error).message);
    }
  }
}
