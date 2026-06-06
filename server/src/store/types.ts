/**
 * Frontmatter shapes for the per-entity markdown files (spec §5). These are the
 * human-editable source of truth; the SQLite index is derived from them.
 * Cross-entity links use slugs/ids (resolved to FK ids during reindex).
 */

export interface TaskFrontmatter {
  id: string;
  title: string;
  status?: string; // §6 state machine; defaults to "inbox"
  priority?: string | null;
  deadline?: string | number | Date | null; // ISO date in markdown
  estimate?: number | null; // minutes
  project?: string | null; // project slug
  fleet?: string | null; // fleet slug
  deliveryMode?: string | null; // per-task override
  permissionMode?: string | null; // auto|manual|dangerous override (null = inherit)
  parentTask?: string | null; // parent task id
  blockedBy?: string[]; // task ids that block this one (→ task_deps edges on reindex)
  labels?: string[]; // stays in markdown only (not indexed as a column)
}

export interface ProjectFrontmatter {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  rootPath?: string | null;
  gitRemote?: string | null;
  defaultModel?: string | null;
  defaultPermissionMode?: string;
  defaultDeliveryMode?: string;
  autonomy?: boolean | null; // per-project autonomy override (null = inherit global)
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
