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

/** Payload of a `notify` ServerMessage — drives in-app badges + OS notifications. */
export interface NotifyPayload {
  kind: "needs_feedback" | "delivered" | "info";
  title: string;
  message: string;
  taskId?: string;
}

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

/** Deadline-driven urgency banding (Principle 12) — drives board order + badges. */
export type UrgencyTier = "overdue" | "due_soon" | "upcoming" | "none";

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
  /** Computed at request time: urgency = f(deadline, priority). Not persisted. */
  urgency?: number;
  urgencyTier?: UrgencyTier;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
}

/** A ranked search result (FTS5 over task text). */
export interface SearchHit {
  taskId: string;
  title: string;
  status: string;
}

// ------------------------------------------------------- suggestions (§10.2)
// "Propose, don't impose": every decidable field can carry a Claude suggestion
// the user can Accept / Edit / Override / Dismiss, with per-field provenance.

export const SUGGESTION_STATUSES = [
  "suggested",
  "confirmed",
  "edited",
  "overridden",
  "dismissed",
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export type SuggestionAction = "accept" | "edit" | "override" | "dismiss";

export interface Suggestion {
  id: string;
  entityType: string; // task | project | …
  entityId: string;
  field: string;
  value: unknown; // the suggested (or edited/overridden) value
  rationale: string | null;
  confidence: number | null; // 0..1
  status: string;
  source: string | null; // which agent/role proposed it
  createdAt: number;
  resolvedAt: number | null;
}

export interface CreateSuggestionInput {
  entityType: string;
  entityId: string;
  field: string;
  value: unknown;
  rationale?: string;
  confidence?: number;
  source?: string;
}

export interface ResolveSuggestionInput {
  action: SuggestionAction;
  /** New value for edit/override. */
  value?: unknown;
}

/** Task plus the list-valued fields that live in markdown (not the index). */
export interface TaskDetail extends Task {
  labels: string[];
  /** Effective permission mode after task ?? project ?? global resolution (§9.1). */
  resolvedPermissionMode: string;
  /** Sum of this task's session costs (effort signal, not a budget). */
  costUsd: number;
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

/** A reusable subagent definition injected via `claude --agents <json>` (spec §7.3). */
export interface SubagentDef {
  description: string;
  prompt: string; // the subagent's system prompt
  tools?: string[]; // allowed tools (read-only for explorers/reviewers)
  model?: string;
}

/** Result of a one-shot agent run (`claude -p --output-format json`) — Phase 2. */
export interface AgentResult {
  /** The final result text. */
  text: string;
  /** Parsed JSON if the agent returned JSON (incl. fenced ```json blocks), else null. */
  json: unknown | null;
  costUsd: number;
  sessionId: string | null;
  isError: boolean;
  /** The raw parsed output object from claude. */
  raw: unknown;
}

export interface GlobalSettings {
  version: number;
  global: {
    defaultModel: string | null;
    defaultPermissionMode: string;
    defaultDeliveryMode: string;
    systemPrompt: string;
    /** Master autonomy switch — when on, triage runs automatically on capture (Phase 2). */
    autonomy?: boolean;
  };
  preferredTerminal: string;
}

/** Supported terminal apps for one-click handoff (macOS). */
export const TERMINAL_APPS = ["Terminal", "iTerm"] as const;

export interface OpenTerminalResult {
  ok: boolean;
  command: string;
}

/** Ambient usage summary derived from ~/.claude/stats-cache.json. */
export interface UsageStats {
  totalSessions: number;
  totalMessages: number;
  lastComputedDate: string | null;
  recentDay: { date: string; messages: number; sessions: number; tokens: number } | null;
  /** Sum over the most recent 7 days present in the data. */
  week: { messages: number; sessions: number; tokens: number };
  topModels: Array<{ model: string; tokens: number }>;
}

export interface UsageResponse {
  stats: UsageStats;
  /** Latest rate_limit_info captured from a live session (5h/weekly windows), if any. */
  rateLimit: unknown | null;
}

/** A discovered project directory (from ~/.claude/projects) proposed for import. */
export interface ImportCandidate {
  cwd: string;
  name: string;
  gitRemote: string | null;
  gitBranch: string | null;
  isGitRepo: boolean;
  alreadyImported: boolean;
}

export interface ImportSelection {
  cwd: string;
  name: string;
  gitRemote?: string | null;
  systemPrompt?: string;
}

export interface ImportRequest {
  selections: ImportSelection[];
}

/** Claude-enrichment of a candidate (one-shot `claude -p`). */
export interface EnrichResult {
  description: string | null;
  stack: string | null;
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

/** A ranked Q&A card from the Questioner agent (agent-prompts §3). */
export type QAQuestionType = "text" | "single_choice" | "multi_choice" | "boolean";
export interface QAQuestion {
  id: string;
  rank: number;
  type: string; // QAQuestionType
  text: string;
  options?: string[];
  why?: string;
}

/** The structured Q&A channel (qa.md frontmatter) for a task. */
export interface QAChannel {
  questions: QAQuestion[];
  answers: Record<string, string | string[]>;
}

export interface SubmitAnswersInput {
  answers: Record<string, string | string[]>;
}

/** A recorded event in a task's timeline (status changes, agent runs, …). */
export interface TaskEvent {
  id: number;
  taskId: string | null;
  sessionId: string | null;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface AppendContextInput {
  text: string;
}

// ------------------------------------------------------------- Daily Digest (§10.3)
// The morning planning ritual: a deadline-first shortlist Claude proposes and I
// commit as today's goal. Each day persists to ~/.cadence/digests/<date>.md.

export interface DigestPick {
  taskId: string;
  title: string;
  status: string;
  /** One-line reason this made the shortlist (e.g. "Overdue · P0", "Ready to start"). */
  rationale: string;
  /** Position in the plan (0-based). */
  order: number;
  urgencyTier: UrgencyTier;
}

export type DigestStatus = "planning" | "committed";

export interface DailyDigest {
  date: string; // YYYY-MM-DD (server-local)
  status: DigestStatus; // "planning" = a fresh proposal; "committed" = my locked-in plan
  picks: DigestPick[];
  goal: string | null; // free-form "what matters most today"
  constraints: string | null; // meetings / energy / etc.
  committedAt: number | null;
}

export interface CommitDigestInput {
  date?: string; // defaults to today
  /** Ordered task ids that make up today's committed plan. */
  picks: string[];
  goal?: string | null;
  constraints?: string | null;
}
