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

/** A match inside a session transcript (§10 — search across sessions). */
export interface TranscriptHit {
  sessionId: string;
  taskId: string | null;
  snippet: string;
}

/** A saved search/filter the user can re-run from the palette. */
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  createdAt: number;
}

export interface CreateSavedSearchInput {
  name: string;
  query: string;
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
  parentTask?: string | null; // parent task id (subtasks); null to detach
}

/** A task's dependency relationships, resolved (spec §4 blocks[]/blockedBy[]). */
export interface TaskDepsView {
  blockedBy: Task[]; // must finish before this task
  blocks: Task[]; // this task must finish before these
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
  /** Per-project autonomy override: true = on, false = off, null = inherit global (§9.1). */
  autonomy: boolean | null;
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
  autonomy?: boolean | null;
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
  autonomy?: boolean | null;
  systemPrompt?: string | null;
  notes?: string | null;
}

// --------------------------------------------------------------- analytics (§10)
// Cost & throughput, derived from sessions (cost) + the status_change timeline.

export interface ProjectAnalytics {
  projectId: string | null;
  projectName: string;
  tasks: number;
  done: number;
  sessions: number;
  costUsd: number;
}

export interface ThroughputDay {
  date: string; // YYYY-MM-DD
  completed: number; // tasks moved to done that day
}

export interface AnalyticsSummary {
  totalCostUsd: number;
  totalSessions: number;
  totalTasks: number;
  doneTasks: number;
  byStatus: Record<string, number>;
  byProject: ProjectAnalytics[];
  throughput: ThroughputDay[];
}

// ------------------------------------------------------------------------ fleets
// A named, ordered set of projects for multi-repo tasks (spec §4). Member slugs
// live in the fleet's markdown; the index holds the scalar fields.

export interface Fleet {
  id: string;
  name: string;
  slug: string;
  projects: string[]; // ordered member project slugs
  systemPrompt: string | null;
  notes: string | null;
  createdAt: number;
}

export interface CreateFleetInput {
  name: string;
  projects?: string[];
  systemPrompt?: string;
  notes?: string;
}

export interface UpdateFleetInput {
  name?: string;
  projects?: string[];
  systemPrompt?: string | null;
  notes?: string | null;
}

/** One repo's outcome within a multi-repo fleet run. */
export interface FleetSubResult {
  projectSlug: string;
  projectName: string;
  cwd: string;
  branch: string | null;
  ran: boolean;
  reason?: string;
  costUsd: number;
}

export interface FleetRunResult {
  taskId: string;
  fleet: string;
  results: FleetSubResult[];
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

export type DigestStatus = "planning" | "committed" | "recapped";

/** The evening recap (§10.3): what shipped, what rolled over, a positive note. */
export interface DigestRecap {
  done: number;
  total: number;
  met: boolean; // the plan was met (every pick shipped)
  shipped: string[]; // titles of picks completed today
  rolledOver: string[]; // task ids still open → seed tomorrow
  note: string; // personalized, encouragement-only (never guilt)
  recappedAt: number;
}

export interface DailyDigest {
  date: string; // YYYY-MM-DD (server-local)
  status: DigestStatus; // planning = fresh proposal; committed = locked plan; recapped = day closed
  picks: DigestPick[];
  goal: string | null; // free-form "what matters most today"
  constraints: string | null; // meetings / energy / etc.
  committedAt: number | null;
  recap?: DigestRecap | null;
  /** Computed at request time (not persisted): live goal-progress ring. */
  progress?: { done: number; total: number };
  /** Computed at request time: consecutive days the plan was met. */
  streak?: number;
}

export interface CommitDigestInput {
  date?: string; // defaults to today
  /** Ordered task ids that make up today's committed plan. */
  picks: string[];
  goal?: string | null;
  constraints?: string | null;
}

export interface RecapDigestInput {
  date?: string; // defaults to today
}

// --------------------------------------------------------------- execution plan (§7.4)
// The Planner (plan mode, read-only) turns the spec into an ordered, approvable
// implementation plan stored on the task (plan.md). The Implementer (3.4) only
// runs once it's approved.

export interface PlanStep {
  title: string;
  detail?: string;
  files?: string[];
  risky?: boolean; // risky / irreversible — surfaced for review
}

export interface TaskPlan {
  steps: PlanStep[];
  approved: boolean;
  notes: string | null;
}

// --------------------------------------------------------------- verify report (§7.6)
// The Verifier independently checks the implementation against the acceptance
// criteria + runs tests/build/lint (with diverse reviewer subagents), → pass/fail.

export interface VerifyCriterion {
  criterion: string;
  met: boolean;
  evidence?: string;
}
export interface VerifyCheck {
  name: string; // tests | build | lint | …
  passed: boolean;
  output?: string;
}
export interface VerifyIssue {
  severity: string; // high | med | low
  detail: string;
  file?: string;
}
export interface VerifyReport {
  passed: boolean;
  criteria: VerifyCriterion[];
  checks: VerifyCheck[];
  issues: VerifyIssue[];
}

// ----------------------------------------------------------------- delivery (§7.7)
// The Delivery agent writes a human summary; Cadence finalizes per delivery mode:
// branch_summary (commit on branch) / auto_pr (push + gh pr) / apply_in_place.

export interface DeliveryResult {
  mode: string; // branch_summary | auto_pr | apply_in_place
  summary: string;
  branch: string | null;
  prUrl: string | null;
}

/** The task's changes for the Review screen (§7 / §10): unified git diff. */
export interface TaskDiff {
  mode: string;
  branch: string | null;
  diff: string; // unified diff text ("" when there's nothing to show)
}

export interface ReviewActionInput {
  note?: string; // optional note for request-changes
}

// --------------------------------------------------------- tool approvals (§9.1)
// Manual permission mode: each tool action is parked here until I approve/deny it
// in-app (the Agent SDK `canUseTool` round-trip).

export interface ApprovalRequest {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  toolName: string;
  input: unknown;
  createdAt: number;
}

export interface ApprovalDecision {
  allow: boolean;
  reason?: string;
}
