/**
 * Frontmatter shapes for the per-entity markdown files (spec §5). These are the
 * human-editable source of truth; the SQLite index is derived from them.
 * Cross-entity links use slugs/ids (resolved to FK ids during reindex).
 */

export interface TaskFrontmatter {
  id: string;
  title: string;
  /** True while the title is a derived placeholder (description-only capture);
   *  cleared when the user or the refinement pipeline sets a real title. */
  titleGenerated?: boolean;
  status?: string; // §6 state machine; defaults to "inbox"
  priority?: string | null;
  deadline?: string | number | Date | null; // ISO date in markdown
  estimate?: number | null; // minutes
  project?: string | null; // project slug
  fleet?: string | null; // fleet slug
  deliveryMode?: string | null; // per-task override
  prUrl?: string | null; // PR/MR from an auto_pr delivery (server-managed, 6.4.d)
  /** Last known git outcome (branch · base · merged?). Server-managed. */
  gitContext?: import("@cadence/shared").TaskGitContext | null;
  taskType?: string; // standard | code_review (6.5)
  reviewDirection?: string | null; // perform | address (when code_review)
  reviewRef?: string | null; // PR/MR URL under review (when code_review)
  permissionMode?: string | null; // auto|manual|dangerous override (null = inherit)
  parentTask?: string | null; // parent task id
  blockedBy?: string[]; // task ids that block this one (→ task_deps edges on reindex)
  labels?: string[]; // stays in markdown only (not indexed as a column)
  /** Fields the user pinned at capture ("project" | "priority" | "deadline") —
   *  triage must never override them. An explicit "None" pick is a pin too
   *  (the field is listed here but absent above). */
  fixedFields?: string[];
}

/** Recurring task template (`recurring/<id>.md`). The markdown BODY is the
 *  description template that becomes each created task's body. */
export interface RecurringFrontmatter {
  id: string;
  title: string;
  cadence: string; // daily | weekly | monthly
  dayOfWeek?: number | null; // 0–6 (weekly)
  dayOfMonth?: number | null; // 1–31 (monthly)
  time: string; // "HH:MM", gateway-local
  project?: string | null; // project slug
  priority?: string | null;
  paused?: boolean;
  lastTriggeredAt?: string | number | Date | null; // ISO in markdown (server-managed)
  lastTaskId?: string | null; // server-managed
  createdAt?: string | number | Date; // ISO in markdown
}

export interface ProjectFrontmatter {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  rootPath?: string | null;
  gitRemote?: string | null;
  forgeOverride?: import("@cadence/shared").ForgeKind | null; // self-hosted forge hint (6.4.a)
  defaultModel?: string | null;
  defaultPermissionMode?: string;
  defaultDeliveryMode?: string;
  autonomy?: boolean | null; // per-project autonomy override (null = inherit global)
  worktreesEnabled?: boolean; // opt-in worktree isolation (default false → in-place, serialized)
  worktreeCheck?: import("@cadence/shared").WorktreeCheck | null; // last readiness check
  worktreeCheckRun?: import("@cadence/shared").WorktreeCheckRun | null; // running/failed check lifecycle
  /** Per-agent prompt additions (role → text) appended to the agent's global prompt (§6.3.b). */
  agentPrompts?: Record<string, string> | null;
  notes?: string | null;
  // The markdown BODY is the project's systemPrompt context layer (spec §4/§7.1).
}

export interface FleetFrontmatter {
  id: string;
  name: string;
  slug: string;
  projects?: string[]; // ordered project slugs (stays in markdown)
  notes?: string | null;
  // The markdown BODY is the fleet's systemPrompt context layer.
}

// GlobalSettings is part of the API contract — defined in @cadence/shared.
export type { GlobalSettings } from "@cadence/shared";
