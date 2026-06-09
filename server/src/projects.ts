import type { CreateProjectInput, Project, UpdateProjectInput, WorktreeCheck } from "@cadence/shared";
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

/** Persist a worktree-readiness check result (server-managed — not part of the PATCH API). */
export function setProjectWorktreeCheck(db: Db, slug: string, check: WorktreeCheck): Project | null {
  if (!existsSync(paths.projectFile(slug))) return null;
  const { data, body } = readProject(slug);
  writeProject({ ...data, slug, worktreeCheck: check }, body);
  reindexProject(db, slug);
  return getProject(db, slug);
}

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    color: row.color,
    rootPath: row.rootPath,
    gitRemote: row.gitRemote,
    defaultModel: row.defaultModel,
    defaultPermissionMode: row.defaultPermissionMode,
    defaultDeliveryMode: row.defaultDeliveryMode,
    autonomy: row.autonomy ?? null,
    worktreesEnabled: row.worktreesEnabled,
    worktreeCheck: parseWorktreeCheck(row.worktreeCheck),
    systemPrompt: row.systemPrompt,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

function parseWorktreeCheck(raw: string | null): WorktreeCheck | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorktreeCheck;
  } catch {
    return null; // tolerate a corrupt cell rather than break project listing
  }
}
