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
  kind: "needs_feedback" | "plan_review" | "review" | "delivered" | "stalled" | "info";
  title: string;
  message: string;
  taskId?: string;
}

/**
 * The unified "needs you" feed (§10) — everything blocking on the user, derived from
 * persistent state so it survives reloads. Backs the top-bar pill + Attention Center.
 */
export type AttentionKind =
  | "needs_input"
  | "plan_approval"
  | "review_merge"
  | "tool_approval"
  | "stalled";

export interface AttentionItem {
  /** Stable id: `${kind}:${taskId|approvalId}` — used as the React key + flow cursor. */
  id: string;
  kind: AttentionKind;
  taskId?: string;
  approvalId?: string;
  /** Task title, or the tool name for a tool approval. */
  title: string;
  /** Plain-language one-liner, e.g. "3 questions" / "Plan ready · 5 steps". */
  summary: string;
  /** Verb for the resolve button, e.g. "Answer" / "Approve plan". */
  actionLabel: string;
  /** Sort key (urgency = f(deadline, priority); tool approvals rank highest). */
  urgency: number;
  createdAt: number;
}

export interface AttentionResponse {
  items: AttentionItem[];
  count: number;
}

/** A proactive, propose-don't-impose nudge (§8.1) from the sweep + self-monitor. */
export interface Proposal {
  id: string; // stable per kind+count, for notification dedup
  kind: "deadline" | "stale" | "reflect" | "info";
  title: string;
  message: string;
  count?: number;
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
  "plan_review",
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

export const REVIEW_DIRECTIONS = ["perform", "address"] as const;
/** "perform" = I review someone's PR/MR · "address" = fix feedback on my own PR/MR (6.5). */
export type ReviewDirection = (typeof REVIEW_DIRECTIONS)[number];
/** Task flavors (6.5): standard work item vs a code review flowing the same board. */
export type TaskType = "standard" | "code_review";

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
  /** The PR/MR opened by an auto_pr delivery (6.4.d). Server-managed. */
  prUrl: string | null;
  /** Task flavor (6.5): "standard" (default) or "code_review". */
  taskType: string;
  /** Review direction when taskType is code_review (6.5). */
  reviewDirection: string | null;
  /** The PR/MR under review (URL), when taskType is code_review (6.5). */
  reviewRef: string | null;
  parentTaskId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Computed at request time: urgency = f(deadline, priority). Not persisted. */
  urgency?: number;
  urgencyTier?: UrgencyTier;
}

export interface CreateTaskInput {
  /** Optional — when omitted, a provisional title is derived from the description
   *  and the refinement pipeline (triage) names the task properly. */
  title?: string;
  /** The description — the primary capture field. At least one of title/body is required. */
  body?: string;
  /** Capture-time review classification (6.5.a) — set by the capture chips. */
  taskType?: TaskType;
  reviewDirection?: ReviewDirection;
  /** The PR/MR URL under review. */
  reviewRef?: string;
  /** Project slug proposed at capture (e.g. matched from the PR/MR repo). */
  project?: string;
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
  /** True while the title is a derived placeholder (captured description-only) —
   *  cleared once the user or the refinement pipeline sets a real title. */
  titleGenerated: boolean;
  /** Effective permission mode after task ?? project ?? global resolution (§9.1). */
  resolvedPermissionMode: string;
  /** Sum of this task's session costs (effort signal, not a budget). */
  costUsd: number;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string;
  taskType?: TaskType;
  reviewDirection?: ReviewDirection | null;
  reviewRef?: string | null;
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

/** One blocker found by the worktree-readiness check (e.g. ".env not committed"). */
export interface WorktreeCheckBlocker {
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
}

/** Result of the Claude-run "can this repo run from a fresh git worktree?" check (§9).
 *  Propose-don't-impose: it informs the worktreesEnabled toggle, never flips it. */
export interface WorktreeCheck {
  verdict: "ready" | "blockers";
  summary: string;
  blockers: WorktreeCheckBlocker[];
  recommendation: string | null;
  checkedAt: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  rootPath: string | null;
  gitRemote: string | null;
  /** Manual forge override for self-hosted instances the host heuristic can't classify (6.4.a). */
  forgeOverride: ForgeKind | null;
  defaultModel: string | null;
  defaultPermissionMode: string;
  defaultDeliveryMode: string;
  /** Per-project autonomy override: true = on, false = off, null = inherit global (§9.1). */
  autonomy: boolean | null;
  /** Opt-in (§9): run executions in an isolated git worktree. Off by default — not every
   *  repo works from a second checkout (.env files, docker ports, install steps). When off,
   *  executions run in the project working dir on a task branch, one at a time. */
  worktreesEnabled: boolean;
  /** Last worktree-readiness check result (null = never checked). Server-managed. */
  worktreeCheck: WorktreeCheck | null;
  systemPrompt: string | null;
  notes: string | null;
  createdAt: number;
}

export interface CreateProjectInput {
  name: string;
  rootPath?: string;
  color?: string;
  gitRemote?: string;
  forgeOverride?: ForgeKind | null;
  defaultModel?: string;
  defaultPermissionMode?: string;
  defaultDeliveryMode?: string;
  autonomy?: boolean | null;
  worktreesEnabled?: boolean;
  systemPrompt?: string;
  notes?: string;
}

export interface UpdateProjectInput {
  name?: string;
  rootPath?: string | null;
  forgeOverride?: ForgeKind | null;
  color?: string | null;
  gitRemote?: string | null;
  defaultModel?: string | null;
  defaultPermissionMode?: string;
  defaultDeliveryMode?: string;
  autonomy?: boolean | null;
  worktreesEnabled?: boolean;
  systemPrompt?: string | null;
  notes?: string | null;
}

// --------------------------------------------------------- background sweep (§8)
// A scheduled scan surfacing proactive, propose-don't-impose nudges: tasks idling
// too long, and deadlines at risk. Deterministic (no Claude) — the agent-backed
// jobs (Reflector, inbox grooming) layer on top.

export type SweepKind = "stale" | "at_risk";

export interface SweepFinding {
  kind: SweepKind;
  taskId: string;
  title: string;
  status: string;
  detail: string; // e.g. "Idle 12d in refining" / "Overdue by 2d"
}

export interface SweepReport {
  ranAt: number;
  findings: SweepFinding[];
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

/** Self-monitoring signals (§8.1): the raw data the Reflector learns from. */
export interface SelfMonitor {
  provenance: {
    suggested: number;
    confirmed: number;
    edited: number;
    overridden: number;
    dismissed: number;
  };
  /** confirmed / resolved (accepted as-is vs any resolution); null if none resolved. */
  acceptanceRate: number | null;
  verify: { passed: number; failed: number; passRate: number | null };
  rollovers: number; // tasks rolled over across all evening recaps
  staleTasks: number; // currently idling past the sweep threshold
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

/** A tracked session plus runtime info, for the detail view. */
export interface SessionDetail extends Session {
  /** True if the underlying claude process is alive (warm handle OR a running pid). */
  isLive: boolean;
  /** True if Cadence holds a warm stdin handle — "Continue chat" only works then. */
  canChat: boolean;
}

/** Patch to re-organize a session — assign it to a task/project/fleet (null clears). */
export interface UpdateSessionInput {
  taskId?: string | null;
  projectId?: string | null;
  fleetId?: string | null;
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

/** Per-agent user override (6.3.b): only set fields persist; an absent field means default. */
export interface AgentOverride {
  /** Custom prompt template ({{var}} placeholders, see the agent's documented variables). */
  prompt?: string;
  /** Custom model id for this agent's runs. */
  model?: string;
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
  /** Optional explicit path to the `claude` binary; exported as CADENCE_CLAUDE_BIN for agent spawns.
   *  Useful when the app is launched from Finder (no shell PATH) and `claude` isn't auto-discovered. */
  claudeBinPath?: string;
  /** Per-agent prompt/model overrides keyed by registry role (e.g. "discovery", "subagent:explorer").
   *  Only customized agents appear here (6.3.b). */
  agents?: Record<string, AgentOverride>;
  /** Date/time display patterns (PHP-style tokens, 6.3.d). Absent = the defaults
   *  (`d.m.Y` / `d.m.Y H:i:s`); the literal "SYSTEM" defers to the browser locale. */
  formats?: { date?: string; dateTime?: string };
  /** Operations knobs (6.3.e) — §6.1 safety limits; absent keys use the built-in defaults. */
  operations?: {
    stuckThresholdMinutes?: number;
    readStageTimeoutMinutes?: number;
    implementStageTimeoutMinutes?: number;
    maxStageAttemptsPer24h?: number;
    maxConcurrentAgents?: number;
  };
}

/** Wire shape of one agent's prompt definition + current override (GET /api/agents/prompts, 6.3.c). */
export interface AgentPromptInfo {
  role: string;
  kind: "stage" | "subagent";
  label: string;
  description: string;
  defaultModel: string | null;
  variables: Array<{ name: string; doc: string }>;
  defaultTemplate: string;
  override: AgentOverride | null;
}

/** A PR/MR reference parsed from a URL (6.5.a). */
export interface PrRef {
  forge: ForgeKind;
  host: string;
  owner: string;
  repo: string;
  number: number;
  kind: "pr" | "mr";
  url: string;
}

/** POST /api/review/inspect — capture-time review detection (6.5.a, propose-don't-impose). */
export interface ReviewInspectResult {
  ref: PrRef | null;
  /** Slug of the project whose remote matches the PR/MR repo, if any. */
  projectSlug: string | null;
  /** PR/MR author login (best-effort CLI lookup; null when unavailable). */
  author: string | null;
  /** The authenticated CLI account (from the forge probe; null when unavailable). */
  account: string | null;
  /** Inferred: author === account → "address" (it's my PR), else "perform". */
  direction: ReviewDirection;
}

// ----------------------------------------------------- code review (6.5.b)

/** PR/MR metadata for the Review Workspace header. */
export interface ReviewMeta {
  title: string;
  author: string | null;
  state: string;
  baseBranch: string | null;
  headBranch: string | null;
  url: string;
  body: string;
  /** Rolled-up CI verdict when available: success | failure | pending | null. */
  ciStatus: string | null;
}

export interface ReviewThreadComment {
  author: string | null;
  body: string;
  createdAt: string | null;
}

/** One review discussion thread on a PR/MR. */
export interface ReviewThread {
  id: string;
  resolved: boolean;
  resolvable: boolean;
  file: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

/** An inline comment queued for publishing (perform direction). */
export interface ReviewDraftComment {
  file: string;
  line: number;
  body: string;
}

export const REVIEW_VERDICTS = ["comment", "approve", "request_changes"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Git forge kinds Cadence understands (6.4). */
export type ForgeKind = "github" | "gitlab";

/** Parsed git remote (6.4.a). */
export interface ForgeInfo {
  forge: ForgeKind | null;
  host: string;
  owner: string;
  repo: string;
  webUrl: string;
}

/** One forge CLI's local capability (6.4.b). */
export interface ForgeCliStatus {
  cli: "gh" | "glab";
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  /** The authenticated account login when detectable (used for review-direction inference, 6.5). */
  account: string | null;
}

/** GET /api/projects/:id/forge — the project's forge + the matching CLI capability. */
export interface ProjectForgeStatus {
  remote: ForgeInfo | null;
  cli: ForgeCliStatus | null;
  probedAt: number | null;
}

/** Supported terminal apps for one-click handoff (macOS). */
export const TERMINAL_APPS = ["Terminal", "iTerm"] as const;

export interface OpenTerminalResult {
  ok: boolean;
  command: string;
  /** True when the running background process was stopped first (take-over handoff). */
  tookOver?: boolean;
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
  /** Compact one-line JSON of a tool_use input — `Bash({"command":"ls"})` in the UI. */
  toolInput: string | null;
  isSidechain: boolean; // subagent activity (nested in the UI)
  timestamp: string | null;
}

/** The always-on free-form context channel (context.md), append-only. */
export interface ContextChannel {
  content: string;
}

/** A markdown memory file (§8.1): Cadence's self-written, hand-editable context. */
export interface MemoryFile {
  name: string; // without the .md extension
  content: string;
}

/** One reviewable/revertable bullet from the learned memory ("what Cadence learned"). */
export interface LearnedEntry {
  index: number; // position among the file's bullets
  text: string;
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
