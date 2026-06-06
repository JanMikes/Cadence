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

/** The always-on free-form context channel (context.md), append-only. */
export interface ContextChannel {
  content: string;
}

export interface AppendContextInput {
  text: string;
}
