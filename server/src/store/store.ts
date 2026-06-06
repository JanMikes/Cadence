import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { DailyDigest, QAChannel, TaskPlan, VerifyReport } from "@cadence/shared";
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
    autonomy: false, // master autonomy switch (Phase 2); off by default
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

export function writeSettings(settings: GlobalSettings): void {
  mkdirSync(paths.home(), { recursive: true });
  writeFileSync(paths.settings(), `${JSON.stringify(settings, null, 2)}\n`);
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

/** Read a task's Discovery spec (spec.md); "" if none yet (written in Phase 2). */
export function readSpec(id: string): string {
  const file = paths.taskSpec(id);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Write a task's Discovery spec (spec.md) — the Discovery agent's output (§5). */
export function writeSpec(id: string, content: string): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(paths.taskSpec(id), content.endsWith("\n") ? content : `${content}\n`);
}

// ------------------------------------------------- task execution plan (plan.md)

/** Read a task's implementation plan (plan.md frontmatter); empty if none yet. */
export function readPlan(id: string): TaskPlan {
  const file = paths.taskPlan(id);
  if (!existsSync(file)) return { steps: [], approved: false, notes: null };
  const { data } = parseMarkdown<Partial<TaskPlan>>(readFileSync(file, "utf8"));
  return { steps: data.steps ?? [], approved: data.approved ?? false, notes: data.notes ?? null };
}

function renderPlanBody(plan: TaskPlan): string {
  const lines = ["# Implementation plan", plan.approved ? "_Approved._" : "_Awaiting approval._", ""];
  if (plan.steps.length === 0) {
    lines.push("_No steps yet._");
  } else {
    plan.steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.risky ? "⚠️ " : ""}${s.title}`);
      if (s.detail) lines.push(`   ${s.detail}`);
      if (s.files?.length) lines.push(`   _files:_ ${s.files.join(", ")}`);
    });
  }
  if (plan.notes) lines.push("", `> ${plan.notes}`);
  return lines.join("\n");
}

/** Write a task's plan (steps + approval) to plan.md (frontmatter + readable body). */
export function writePlan(id: string, plan: TaskPlan): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(
    paths.taskPlan(id),
    stringifyMarkdown(
      { steps: plan.steps, approved: plan.approved, notes: plan.notes },
      renderPlanBody(plan),
    ),
  );
}

// --------------------------------------------------- task verify report (verify.md)

/** Read a task's Verifier report (verify.md frontmatter); null if none yet. */
export function readVerify(id: string): VerifyReport | null {
  const file = paths.taskVerify(id);
  if (!existsSync(file)) return null;
  const { data } = parseMarkdown<Partial<VerifyReport>>(readFileSync(file, "utf8"));
  return {
    passed: data.passed ?? false,
    criteria: data.criteria ?? [],
    checks: data.checks ?? [],
    issues: data.issues ?? [],
  };
}

function renderVerifyBody(r: VerifyReport): string {
  const lines = [`# Verification — ${r.passed ? "✅ passed" : "❌ failed"}`, ""];
  if (r.checks.length) {
    lines.push("## Checks");
    for (const c of r.checks) lines.push(`- ${c.passed ? "✅" : "❌"} ${c.name}`);
    lines.push("");
  }
  if (r.criteria.length) {
    lines.push("## Acceptance criteria");
    for (const c of r.criteria) lines.push(`- [${c.met ? "x" : " "}] ${c.criterion}`);
    lines.push("");
  }
  if (r.issues.length) {
    lines.push("## Issues");
    for (const i of r.issues) lines.push(`- **${i.severity}** ${i.detail}${i.file ? ` (${i.file})` : ""}`);
  }
  return lines.join("\n");
}

/** Write a task's Verifier report to verify.md (frontmatter + readable body). */
export function writeVerify(id: string, report: VerifyReport): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(
    paths.taskVerify(id),
    stringifyMarkdown(
      { passed: report.passed, criteria: report.criteria, checks: report.checks, issues: report.issues },
      renderVerifyBody(report),
    ),
  );
}

// ----------------------------------------------------- task Q&A channel (qa.md)

/** Read a task's structured Q&A (qa.md frontmatter); empty if none yet. */
export function readQa(id: string): QAChannel {
  const file = paths.taskQa(id);
  if (!existsSync(file)) return { questions: [], answers: {} };
  const { data } = parseMarkdown<Partial<QAChannel>>(readFileSync(file, "utf8"));
  return { questions: data.questions ?? [], answers: data.answers ?? {} };
}

function renderQaBody(qa: QAChannel): string {
  return qa.questions
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((q) => {
      const ans = qa.answers[q.id];
      const a = Array.isArray(ans) ? ans.join(", ") : (ans ?? "");
      const opts = q.options?.length ? ` (${q.options.join(" / ")})` : "";
      return `### ${q.rank}. ${q.text}${opts}\n_${q.why ?? ""}_\n\n**Answer:** ${a || "—"}`;
    })
    .join("\n\n");
}

/** Write a task's Q&A (questions + answers) to qa.md (frontmatter + readable body). */
export function writeQa(id: string, qa: QAChannel): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(
    paths.taskQa(id),
    stringifyMarkdown({ questions: qa.questions, answers: qa.answers }, renderQaBody(qa)),
  );
}

// --------------------------------------------------- Daily Digest (digests/<date>.md)

/** Read a committed digest for a date; null if none has been committed yet. */
export function readDigest(date: string): DailyDigest | null {
  const file = paths.digestFile(date);
  if (!existsSync(file)) return null;
  const { data } = parseMarkdown<Partial<DailyDigest>>(readFileSync(file, "utf8"));
  const status =
    data.status === "committed" || data.status === "recapped" ? data.status : "planning";
  return {
    date: data.date ?? date,
    status,
    picks: data.picks ?? [],
    goal: data.goal ?? null,
    constraints: data.constraints ?? null,
    committedAt: data.committedAt ?? null,
    recap: data.recap ?? null,
  };
}

function renderDigestBody(digest: DailyDigest): string {
  const lines = [`# Today — ${digest.date}`];
  if (digest.goal) lines.push("", `**Goal:** ${digest.goal}`);
  if (digest.constraints) lines.push("", `**Constraints:** ${digest.constraints}`);
  lines.push("", "## Plan");
  if (digest.picks.length === 0) {
    lines.push("_No tasks picked._");
  } else {
    for (const p of digest.picks.slice().sort((a, b) => a.order - b.order)) {
      lines.push(`${p.order + 1}. ${p.title} — _${p.rationale}_ (${p.status})`);
    }
  }
  if (digest.recap) {
    lines.push("", "## Recap", `**${digest.recap.done}/${digest.recap.total} shipped.** ${digest.recap.note}`);
    if (digest.recap.shipped.length) lines.push("", `Shipped: ${digest.recap.shipped.join("; ")}`);
  }
  return lines.join("\n");
}

/** Persist a digest to digests/<date>.md (frontmatter + a readable plan body). */
export function writeDigest(digest: DailyDigest): void {
  mkdirSync(paths.digestsDir(), { recursive: true });
  writeFileSync(
    paths.digestFile(digest.date),
    stringifyMarkdown(
      {
        date: digest.date,
        status: digest.status,
        picks: digest.picks,
        goal: digest.goal,
        constraints: digest.constraints,
        committedAt: digest.committedAt,
        recap: digest.recap ?? null,
      },
      renderDigestBody(digest),
    ),
  );
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
    autonomy: data.autonomy ?? null,
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
    permissionMode: data.permissionMode ?? null,
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
