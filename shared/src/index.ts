/**
 * Shared constants & types — the server ⇄ web contract.
 * Grows as Cadence's API/storage shape evolves (typed contract lands in 0.6).
 */

export const APP_NAME = "Cadence" as const;
export const APP_TAGLINE = "Your backlog, in flow." as const;

/** Bumped whenever the on-disk / API contract changes. */
export const SCHEMA_VERSION = 1 as const;

export interface HealthStatus {
  ok: boolean;
  app: typeof APP_NAME;
  version: number;
}

// ----------------------------------------------------------------- WS contract
// The gateway pushes ServerMessages to connected web clients; clients send
// ClientMessages back. Both are JSON. This grows as live features land.

export interface HelloMessage {
  type: "hello";
  app: typeof APP_NAME;
  version: number;
}

/** A named domain event (e.g. reindex, task/session updates). */
export interface EventMessage {
  type: "event";
  name: string;
  payload?: unknown;
}

export type ServerMessage = HelloMessage | EventMessage;

export type ClientMessage = { type: "ping" } | { type: "subscribe"; topic?: string };

// -------------------------------------------------------------------- entities
// DTOs returned by the REST API — the indexed (queryable) view of each entity.
// The markdown under ~/.cadence/ remains the source of truth (spec §5).

/** Lifecycle states (spec §6). */
export const TASK_STATUSES = [
  "inbox",
  "triaged",
  "refining",
  "needs_feedback",
  "ready",
  "implementing",
  "verifying",
  "review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: string | null;
  projectId: string | null;
  fleetId: string | null;
  deadline: number | null;
  estimate: number | null;
  deliveryMode: string | null;
  permissionMode: string | null; // explicit override (null = inherit project ?? global)
  parentTaskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
}

/** Task plus the list-valued fields that live in markdown (not the index). */
export interface TaskDetail extends Task {
  labels: string[];
  /** Effective permission mode after task ?? project ?? global resolution (§9.1). */
  resolvedPermissionMode: string;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string;
  status?: string;
  priority?: string | null;
  deadline?: number | null; // epoch ms
  estimate?: number | null; // minutes
  labels?: string[];
  deliveryMode?: string | null;
  permissionMode?: string | null; // auto|manual|dangerous override (null = inherit)
  project?: string | null; // project slug (null to unassign)
  fleet?: string | null; // fleet slug
}

export const PERMISSION_MODES = ["auto", "manual", "dangerous"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DELIVERY_MODES = ["branch_summary", "auto_pr", "apply_in_place"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export interface Project {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  rootPath: string | null;
  gitRemote: string | null;
  defaultModel: string | null;
  defaultPermissionMode: string;
  defaultDeliveryMode: string;
  systemPrompt: string | null;
  notes: string | null;
  createdAt: number;
}

export interface CreateProjectInput {
  name: string;
  rootPath?: string;
  color?: string;
  gitRemote?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  defaultDeliveryMode?: string;
  systemPrompt?: string;
  notes?: string;
}

export interface UpdateProjectInput {
  name?: string;
  rootPath?: string | null;
  color?: string | null;
  gitRemote?: string | null;
  defaultModel?: string | null;
  defaultPermissionMode?: string;
  defaultDeliveryMode?: string;
  systemPrompt?: string | null;
  notes?: string | null;
}

// --------------------------------------------------------------- Claude sessions

/** A Claude Code session we spawned/track (index view of the sessions table). */
export interface Session {
  id: string;
  taskId: string | null;
  projectId: string | null;
  fleetId: string | null;
  role: string;
  kind: string; // warm | oneshot
  status: string; // spawning|running|idle|awaiting_feedback|done|failed|killed
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  pid: number | null;
  model: string | null;
  permissionMode: string | null;
  costUsd: number;
  startedAt: number | null;
  endedAt: number | null;
  transcriptPath: string | null;
}

export interface SpawnSessionInput {
  /** Optional first user message to send to the warm session. */
  prompt?: string;
  model?: string;
  /** Cadence permission mode (auto|manual|dangerous); resolved to a claude mode. */
  permissionMode?: string;
  role?: string;
}

/**
 * A parsed line from `claude --output-format stream-json` (§3.2 of the control
 * surfaces doc). The schema is internal/unversioned, so this stays permissive —
 * we narrow on `type` ("system"/"assistant"/"result"/"stream_event"/…).
 */
export interface ClaudeEvent {
  type: string;
  [key: string]: unknown;
}

/** A live Claude Code process from the liveness oracle (~/.claude/sessions/<pid>.json). */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string; // busy | idle | shell | …
  kind: string; // interactive | …
  version: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  /** Whether the pid is actually alive (a crash can leave a stale file). */
  alive: boolean;
}

/** One rendered line of a past transcript (the parentUuid DAG, flattened). */
export interface TranscriptEntry {
  uuid: string | null;
  parentUuid: string | null;
  role: string; // user | assistant | system | …
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "other";
  text: string | null;
  toolName: string | null;
  isSidechain: boolean; // subagent activity (nested in the UI)
  timestamp: string | null;
}

/** The always-on free-form context channel (context.md), append-only. */
export interface ContextChannel {
  content: string;
}

export interface AppendContextInput {
  text: string;
}
