/**
 * Cadence SQLite index schema (Drizzle).
 *
 * The markdown files under `~/.cadence/` are the SOURCE OF TRUTH; this database
 * only *indexes* the queryable scalar fields (status, priority, deadline, links)
 * so the UI can sort/filter/search fast. It is rebuilt from the markdown by the
 * file watcher (0.5), so losing the DB is always recoverable. List-valued fields
 * (labels, acceptance criteria, context notes, Q&A, fleet project order) live in
 * the markdown, not here.
 *
 * Conventions: text UUID primary keys (caller-generated via crypto.randomUUID),
 * snake_case columns, epoch-millisecond integers for timestamps.
 */

import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/** Project — organizing unit, usually a git repo / working dir (spec §4). */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  color: text("color"),
  rootPath: text("root_path"),
  gitRemote: text("git_remote"),
  // manual forge override for self-hosted instances ("github" | "gitlab"; null = host heuristic)
  forgeOverride: text("forge_override"),
  defaultModel: text("default_model"),
  // auto (default) | manual | dangerous  → real permission modes (§9.1)
  defaultPermissionMode: text("default_permission_mode").notNull().default("auto"),
  // branch_summary | auto_pr | apply_in_place
  defaultDeliveryMode: text("default_delivery_mode").notNull().default("branch_summary"),
  // per-project autonomy override (§9.1): true = on, false = off, null = inherit global
  autonomy: integer("autonomy", { mode: "boolean" }),
  // opt-in worktree isolation (§9): off by default — not every repo runs from a fresh
  // checkout. When off, executions run in rootPath on a task branch, serialized per project.
  worktreesEnabled: integer("worktrees_enabled", { mode: "boolean" }).notNull().default(false),
  // last worktree-readiness check (JSON WorktreeCheck; null = never checked)
  worktreeCheck: text("worktree_check"),
  // readiness-check lifecycle (JSON WorktreeCheckRun; null = idle) — running/failed
  // persists so the UI never loses an in-flight or failed check when a panel closes
  worktreeCheckRun: text("worktree_check_run"),
  systemPrompt: text("system_prompt"),
  // per-agent prompt additions (JSON Record<role, text>; null = none) — appended to the
  // agent's global prompt for runs on this project's tasks (§6.3.b project layer)
  agentPrompts: text("agent_prompts"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull().default(now),
});

/** Fleet — named set of projects for multi-repo tasks (spec §4). Ordered
 *  projectIds live in the fleet's markdown; this indexes the scalar fields. */
export const fleets = sqliteTable("fleets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  systemPrompt: text("system_prompt"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull().default(now),
});

/** Task — the core entity (spec §4, §6). A task targets a project XOR a fleet
 *  XOR nothing (unassigned), expressed via the two nullable FKs. */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // §6 state machine: inbox|triaged|refining|needs_feedback|ready|plan_review|
  //                    implementing|verifying|review|done|blocked|cancelled
  status: text("status").notNull().default("inbox"),
  // Priority scale is intentionally not fixed yet (decided with the UI in 1.2);
  // stored as-is from the task.md frontmatter.
  priority: text("priority"),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  fleetId: text("fleet_id").references(() => fleets.id, { onDelete: "set null" }),
  deadline: integer("deadline"),
  estimate: integer("estimate"), // minutes
  deliveryMode: text("delivery_mode"), // per-task override of project/global
  prUrl: text("pr_url"), // PR/MR opened by an auto_pr delivery (6.4.d; server-managed)
  // last known git outcome (JSON TaskGitContext; server-managed) — branch · base · merged?
  gitContext: text("git_context"),
  // standard | code_review (6.5) — reviews flow the same board with a type badge
  taskType: text("task_type").notNull().default("standard"),
  reviewDirection: text("review_direction"), // perform | address (when code_review)
  reviewRef: text("review_ref"), // the PR/MR URL under review (when code_review)
  // auto|manual|dangerous override; null = inherit project ?? global (§9.1)
  permissionMode: text("permission_mode"),
  parentTaskId: text("parent_task_id"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/** Recurring task — a task *template* + schedule. The markdown under
 *  `~/.cadence/recurring/` is the source of truth; the background scheduler
 *  creates a real task at each trigger (next_run_at <= now). */
export const recurringTasks = sqliteTable("recurring_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // daily | weekly | monthly
  cadence: text("cadence").notNull(),
  dayOfWeek: integer("day_of_week"), // 0–6 (JS getDay; weekly only)
  dayOfMonth: integer("day_of_month"), // 1–31, clamped to month length (monthly only)
  time: text("time").notNull(), // "HH:MM", gateway-local
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  priority: text("priority"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  lastTriggeredAt: integer("last_triggered_at"),
  lastTaskId: text("last_task_id"), // most recently created task (no FK — survives task deletion)
  // Derived at reindex: next occurrence after (lastTriggeredAt ?? createdAt);
  // null while paused. A past value = due (fires on the scheduler's next tick).
  nextRunAt: integer("next_run_at"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/** Task dependency edge: `blocker` blocks `blocked` (i.e. `blocked` is blockedBy
 *  `blocker`). The blocks[]/blockedBy[] graph from spec §4. */
export const taskDeps = sqliteTable(
  "task_deps",
  {
    blockerTaskId: text("blocker_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    blockedTaskId: text("blocked_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.blockerTaskId, t.blockedTaskId] })],
);

/** Claude Code session — our wrapper around a real session (spec §4). */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // = claude session_id
  taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  fleetId: text("fleet_id").references(() => fleets.id, { onDelete: "set null" }),
  // triage|discovery|questioner|planner|implementer|verifier|delivery|chat|import|digest
  role: text("role").notNull(),
  kind: text("kind").notNull().default("warm"), // warm | oneshot
  // spawning|running|idle|awaiting_feedback|done|failed|killed
  status: text("status").notNull().default("spawning"),
  cwd: text("cwd").notNull(),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  pid: integer("pid"),
  model: text("model"),
  permissionMode: text("permission_mode"),
  costUsd: real("cost_usd").notNull().default(0),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
  transcriptPath: text("transcript_path"),
});

/** Event — append-only timeline (status changes, spawns, tool-use, results,
 *  needs-feedback, delivery). Powers the status timeline + analytics. */
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payload: text("payload"), // JSON
  createdAt: integer("created_at").notNull().default(now),
});

/** Suggestion — the "propose, don't impose" provenance record (spec §10.2,
 *  step 1.14): a suggested field value + its resolution (accept/edit/override). */
export const suggestions = sqliteTable("suggestions", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(), // task | project | fleet
  entityId: text("entity_id").notNull(),
  field: text("field").notNull(),
  suggestedValue: text("suggested_value"), // JSON-encoded
  rationale: text("rationale"),
  confidence: real("confidence"), // 0..1 (§10.2)
  // suggested | confirmed | edited | overridden | dismissed
  status: text("status").notNull().default("suggested"),
  source: text("source"), // which agent/role proposed it
  createdAt: integer("created_at").notNull().default(now),
  resolvedAt: integer("resolved_at"),
});

export const schema = {
  projects,
  fleets,
  tasks,
  recurringTasks,
  taskDeps,
  sessions,
  events,
  suggestions,
};
