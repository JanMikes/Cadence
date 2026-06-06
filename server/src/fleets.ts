import type { CreateFleetInput, Fleet, Project, UpdateFleetInput } from "@cadence/shared";
import { asc, eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import type { Db } from "./db/client";
import { fleets } from "./db/schema";
import { getProject } from "./projects";
import { paths } from "./store/paths";
import { readFleet, reindexFleet, writeFleet } from "./store/store";
import type { FleetFrontmatter } from "./store/types";

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
  return s || "fleet";
}

function uniqueSlug(base: string): string {
  let slug = base;
  let n = 2;
  while (existsSync(paths.fleetFile(slug))) slug = `${base}-${n++}`;
  return slug;
}

export function createFleet(db: Db, input: CreateFleetInput): Fleet {
  const slug = uniqueSlug(slugify(input.name));
  const id = crypto.randomUUID();
  const fm: FleetFrontmatter = {
    id,
    name: input.name,
    slug,
    projects: input.projects ?? [],
    notes: input.notes ?? null,
  };
  writeFleet(fm, input.systemPrompt ?? "");
  reindexFleet(db, slug);
  const fleet = getFleet(db, slug);
  if (!fleet) throw new Error(`createFleet: ${slug} missing after reindex`);
  return fleet;
}

export function listFleets(db: Db): Fleet[] {
  return db
    .select()
    .from(fleets)
    .orderBy(asc(fleets.name))
    .all()
    .map((row) => toFleet(row, fleetProjects(row.slug)));
}

export function getFleet(db: Db, slug: string): Fleet | null {
  const row = db.select().from(fleets).where(eq(fleets.slug, slug)).get();
  return row ? toFleet(row, fleetProjects(slug)) : null;
}

export function getFleetById(db: Db, id: string): Fleet | null {
  const row = db.select().from(fleets).where(eq(fleets.id, id)).get();
  return row ? toFleet(row, fleetProjects(row.slug)) : null;
}

export function updateFleet(db: Db, slug: string, patch: UpdateFleetInput): Fleet | null {
  if (!existsSync(paths.fleetFile(slug))) return null;
  const { data, body } = readFleet(slug);
  const next: FleetFrontmatter = { ...data, slug };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.projects !== undefined) next.projects = patch.projects;
  if (patch.notes !== undefined) next.notes = patch.notes;
  const nextPrompt = patch.systemPrompt !== undefined ? (patch.systemPrompt ?? "") : body;

  writeFleet(next, nextPrompt);
  reindexFleet(db, slug);
  return getFleet(db, slug);
}

/** The fleet's member projects, in order (missing slugs skipped). */
export function fleetMembers(db: Db, slug: string): Project[] {
  const members: Project[] = [];
  for (const projectSlug of fleetProjects(slug)) {
    const project = getProject(db, projectSlug);
    if (project) members.push(project);
  }
  return members;
}

/** Member slugs live in the fleet markdown (not the index) — read them there. */
function fleetProjects(slug: string): string[] {
  if (!existsSync(paths.fleetFile(slug))) return [];
  try {
    return readFleet(slug).data.projects ?? [];
  } catch {
    return [];
  }
}

function toFleet(row: typeof fleets.$inferSelect, projects: string[]): Fleet {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    projects,
    systemPrompt: row.systemPrompt,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}
