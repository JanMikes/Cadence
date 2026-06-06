import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { fleets, projects, tasks } from "../db/schema";
import { parseMarkdown, stringifyMarkdown } from "./markdown";
import { paths } from "./paths";
import type {
  FleetFrontmatter,
  GlobalSettings,
  ProjectFrontmatter,
  TaskFrontmatter,
} from "./types";

export const DEFAULT_SETTINGS: GlobalSettings = {
  version: 1,
  global: {
    defaultModel: null,
    defaultPermissionMode: "auto",
    defaultDeliveryMode: "branch_summary",
    systemPrompt: "",
  },
  preferredTerminal: "Terminal",
};

/** Create the ~/.cadence/ directory tree and a default settings.json (idempotent). */
export function bootstrap(): void {
  for (const dir of [
    paths.home(),
    paths.tasksDir(),
    paths.projectsDir(),
    paths.fleetsDir(),
    paths.memoryDir(),
    paths.digestsDir(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(paths.settings())) {
    writeFileSync(paths.settings(), `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
  }
}

export function readSettings(): GlobalSettings {
  if (!existsSync(paths.settings())) return DEFAULT_SETTINGS;
  return JSON.parse(readFileSync(paths.settings(), "utf8")) as GlobalSettings;
}

// ---------------------------------------------------------------- tasks (md I/O)

export function writeTask(fm: TaskFrontmatter, body: string): void {
  mkdirSync(paths.taskDir(fm.id), { recursive: true });
  writeFileSync(paths.taskFile(fm.id), stringifyMarkdown({ ...fm }, body));
}

export function readTask(id: string) {
  return parseMarkdown<TaskFrontmatter>(readFileSync(paths.taskFile(id), "utf8"));
}

export function writeProject(fm: ProjectFrontmatter, systemPrompt = ""): void {
  mkdirSync(paths.projectsDir(), { recursive: true });
  writeFileSync(paths.projectFile(fm.slug), stringifyMarkdown({ ...fm }, systemPrompt));
}

export function readProject(slug: string) {
  return parseMarkdown<ProjectFrontmatter>(readFileSync(paths.projectFile(slug), "utf8"));
}

export function writeFleet(fm: FleetFrontmatter, systemPrompt = ""): void {
  mkdirSync(paths.fleetsDir(), { recursive: true });
  writeFileSync(paths.fleetFile(fm.slug), stringifyMarkdown({ ...fm }, systemPrompt));
}

export function readFleet(slug: string) {
  return parseMarkdown<FleetFrontmatter>(readFileSync(paths.fleetFile(slug), "utf8"));
}

// ------------------------------------------------- task context channel (append-only)

/** Read a task's free-form context channel (context.md); "" if none yet. */
export function readContext(id: string): string {
  const file = paths.taskContext(id);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Append a timestamped note to a task's context.md (append-only, spec §5). */
export function appendContext(id: string, text: string, at: Date = new Date()): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  const entry = `\n## ${at.toISOString()}\n\n${text.trim()}\n`;
  appendFileSync(paths.taskContext(id), entry);
}

// ---------------------------------------------------------------- reindex (md → DB)

function toEpochMs(value: string | number | Date | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Reindex one project's markdown into the index (body = systemPrompt). */
export function reindexProject(db: Db, slug: string): void {
  const { data, body } = readProject(slug);
  const row = {
    id: data.id,
    name: data.name,
    slug: data.slug,
    color: data.color ?? null,
    rootPath: data.rootPath ?? null,
    gitRemote: data.gitRemote ?? null,
    defaultModel: data.defaultModel ?? null,
    defaultPermissionMode: data.defaultPermissionMode ?? "auto",
    defaultDeliveryMode: data.defaultDeliveryMode ?? "branch_summary",
    systemPrompt: body || null,
    notes: data.notes ?? null,
  };
  db.insert(projects)
    .values(row)
    .onConflictDoUpdate({ target: projects.id, set: row })
    .run();
}

/** Reindex one fleet's markdown into the index (body = systemPrompt; ordered
 *  projectIds stay in markdown). */
export function reindexFleet(db: Db, slug: string): void {
  const { data, body } = readFleet(slug);
  const row = {
    id: data.id,
    name: data.name,
    slug: data.slug,
    systemPrompt: body || null,
    notes: data.notes ?? null,
  };
  db.insert(fleets).values(row).onConflictDoUpdate({ target: fleets.id, set: row }).run();
}

/** Reindex one task's task.md into the index. Project/fleet slugs are resolved to
 *  FK ids (null if not yet indexed). FTS stays in sync via DB triggers. */
export function reindexTask(db: Db, id: string): void {
  const { data, body } = readTask(id);

  const projectId = data.project
    ? (db.select({ id: projects.id }).from(projects).where(eq(projects.slug, data.project)).get()
        ?.id ?? null)
    : null;
  const fleetId = data.fleet
    ? (db.select({ id: fleets.id }).from(fleets).where(eq(fleets.slug, data.fleet)).get()?.id ??
      null)
    : null;

  const row = {
    id: data.id,
    title: data.title,
    body,
    status: data.status ?? "inbox",
    priority: data.priority ?? null,
    projectId,
    fleetId,
    deadline: toEpochMs(data.deadline),
    estimate: data.estimate ?? null,
    deliveryMode: data.deliveryMode ?? null,
    parentTaskId: data.parentTask ?? null,
    updatedAt: Date.now(),
  };
  db.insert(tasks)
    .values(row)
    .onConflictDoUpdate({ target: tasks.id, set: row })
    .run();
}

/** Full reindex from disk: projects + fleets first (so task links resolve), then
 *  tasks. Recovers the entire index from the markdown source of truth. */
export function reindexAll(db: Db): void {
  for (const file of listMarkdown(paths.projectsDir())) reindexProject(db, basenameNoExt(file));
  for (const file of listMarkdown(paths.fleetsDir())) reindexFleet(db, basenameNoExt(file));
  for (const id of listTaskIds()) reindexTask(db, id);
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}

function basenameNoExt(file: string): string {
  return file.replace(/\.md$/, "");
}

export function listTaskIds(): string[] {
  const dir = paths.tasksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(paths.taskFile(e.name)))
    .map((e) => e.name);
}
