import type {
  CreateProjectInput,
  Project,
  UpdateProjectInput,
  WorktreeCheck,
  WorktreeCheckRun,
} from "@cadence/shared";
import { asc, eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import type { Db } from "./db/client";
import { projects } from "./db/schema";
import { paths } from "./store/paths";
import { readProject, readSettings, reindexProject, writeProject } from "./store/store";
import type { ProjectFrontmatter } from "./store/types";

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
  return s || "project";
}

/** A slug not already taken by an existing project file. */
function uniqueSlug(base: string): string {
  let slug = base;
  let n = 2;
  while (existsSync(paths.projectFile(slug))) slug = `${base}-${n++}`;
  return slug;
}

export function createProject(db: Db, input: CreateProjectInput): Project {
  const slug = uniqueSlug(slugify(input.name));
  const id = crypto.randomUUID();
  const fm: ProjectFrontmatter = {
    id,
    name: input.name,
    slug,
    color: input.color ?? null,
    rootPath: input.rootPath ?? null,
    gitRemote: input.gitRemote ?? null,
    forgeOverride: input.forgeOverride ?? null,
    defaultModel: input.defaultModel ?? null,
    defaultPermissionMode: input.defaultPermissionMode ?? "auto",
    defaultDeliveryMode: input.defaultDeliveryMode ?? "branch_summary",
    autonomy: input.autonomy ?? null,
    worktreesEnabled: input.worktreesEnabled ?? false,
    notes: input.notes ?? null,
  };
  writeProject(fm, input.systemPrompt ?? "");
  reindexProject(db, slug);
  const project = getProject(db, slug);
  if (!project) throw new Error(`createProject: ${slug} missing after reindex`);
  return project;
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).orderBy(asc(projects.name)).all().map(toProject);
}

export function getProject(db: Db, slug: string): Project | null {
  const row = db.select().from(projects).where(eq(projects.slug, slug)).get();
  return row ? toProject(row) : null;
}

export function getProjectById(db: Db, id: string): Project | null {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  return row ? toProject(row) : null;
}

export function getProjectByRootPath(db: Db, rootPath: string): Project | null {
  const row = db.select().from(projects).where(eq(projects.rootPath, rootPath)).get();
  return row ? toProject(row) : null;
}

/**
 * Effective autonomy for a task in (optionally) a project: the project's own
 * override if set, else the global switch (§9.1, resolved project ?? global).
 * Gates whether Cadence auto-continues the refinement pipeline.
 */
export function resolveProjectAutonomy(db: Db, projectId: string | null): boolean {
  const globalOn = readSettings().global.autonomy ?? false;
  if (!projectId) return globalOn;
  const project = getProjectById(db, projectId);
  if (project && project.autonomy != null) return project.autonomy;
  return globalOn;
}

export function updateProject(db: Db, slug: string, patch: UpdateProjectInput): Project | null {
  if (!existsSync(paths.projectFile(slug))) return null;
  const { data, body } = readProject(slug);

  const next: ProjectFrontmatter = { ...data, slug };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.rootPath !== undefined) next.rootPath = patch.rootPath;
  if (patch.gitRemote !== undefined) next.gitRemote = patch.gitRemote;
  if (patch.forgeOverride !== undefined) next.forgeOverride = patch.forgeOverride;
  if (patch.defaultModel !== undefined) next.defaultModel = patch.defaultModel;
  if (patch.defaultPermissionMode !== undefined) next.defaultPermissionMode = patch.defaultPermissionMode;
  if (patch.defaultDeliveryMode !== undefined) next.defaultDeliveryMode = patch.defaultDeliveryMode;
  if (patch.autonomy !== undefined) next.autonomy = patch.autonomy;
  if (patch.worktreesEnabled !== undefined) next.worktreesEnabled = patch.worktreesEnabled;
  if (patch.notes !== undefined) next.notes = patch.notes;
  const nextPrompt = patch.systemPrompt !== undefined ? (patch.systemPrompt ?? "") : body;

  writeProject(next, nextPrompt);
  reindexProject(db, slug);
  return getProject(db, slug);
}

/** Persist a worktree-readiness check result (server-managed — not part of the PATCH API).
 *  A completed verdict also clears the run lifecycle (the check is no longer running/failed). */
export function setProjectWorktreeCheck(db: Db, slug: string, check: WorktreeCheck): Project | null {
  if (!existsSync(paths.projectFile(slug))) return null;
  const { data, body } = readProject(slug);
  writeProject({ ...data, slug, worktreeCheck: check, worktreeCheckRun: null }, body);
  reindexProject(db, slug);
  return getProject(db, slug);
}

/** Persist the readiness-check lifecycle (running/failed; null = idle) so the UI can show
 *  it any time — a closed panel must never lose an in-flight or failed check. */
export function setProjectWorktreeCheckRun(db: Db, slug: string, run: WorktreeCheckRun | null): Project | null {
  if (!existsSync(paths.projectFile(slug))) return null;
  const { data, body } = readProject(slug);
  writeProject({ ...data, slug, worktreeCheckRun: run }, body);
  reindexProject(db, slug);
  return getProject(db, slug);
}

/** Boot-time recovery: a check left "running" by a dead gateway would spin forever —
 *  mark it failed so the panel says what happened instead of lying. Returns # fixed. */
export function failStaleWorktreeCheckRuns(db: Db): number {
  let fixed = 0;
  for (const project of listProjects(db)) {
    const run = project.worktreeCheckRun;
    if (run?.status !== "running") continue;
    setProjectWorktreeCheckRun(db, project.slug, {
      status: "failed",
      startedAt: run.startedAt,
      reason: "the gateway restarted mid-check — run it again",
    });
    fixed++;
  }
  return fixed;
}

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    color: row.color,
    rootPath: row.rootPath,
    gitRemote: row.gitRemote,
    forgeOverride: (row.forgeOverride as Project["forgeOverride"]) ?? null,
    defaultModel: row.defaultModel,
    defaultPermissionMode: row.defaultPermissionMode,
    defaultDeliveryMode: row.defaultDeliveryMode,
    autonomy: row.autonomy ?? null,
    worktreesEnabled: row.worktreesEnabled,
    worktreeCheck: parseJsonCell<WorktreeCheck>(row.worktreeCheck),
    worktreeCheckRun: parseJsonCell<WorktreeCheckRun>(row.worktreeCheckRun),
    systemPrompt: row.systemPrompt,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

function parseJsonCell<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // tolerate a corrupt cell rather than break project listing
  }
}
