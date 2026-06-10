import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type {
  DailyDigest,
  DeliveryResult,
  QAChannel,
  TaskAttachment,
  TaskPlan,
  VerifyReport,
} from "@cadence/shared";
import { computeNextRun, type RecurringCadence } from "@cadence/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { fleets, projects, recurringTasks, taskDeps, tasks } from "../db/schema";
import { parseMarkdown, stringifyMarkdown } from "./markdown";
import { paths } from "./paths";
import type {
  FleetFrontmatter,
  GlobalSettings,
  ProjectFrontmatter,
  RecurringFrontmatter,
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
    paths.recurringDir(),
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

/** Export the configured Claude binary path as `CADENCE_CLAUDE_BIN` — honored by spawn.ts / agents/
 *  runner.ts / import.ts (`process.env.CADENCE_CLAUDE_BIN ?? "claude"`). Set when `claudeBinPath` is
 *  non-empty; cleared when explicitly unset, so the setting is the single source of truth. */
export function applyClaudeBinEnv(settings: GlobalSettings = readSettings()): void {
  const path = settings.claudeBinPath?.trim();
  if (path) process.env.CADENCE_CLAUDE_BIN = path;
  else delete process.env.CADENCE_CLAUDE_BIN;
}

// ---------------------------------------------------------------- tasks (md I/O)

export function writeTask(fm: TaskFrontmatter, body: string): void {
  mkdirSync(paths.taskDir(fm.id), { recursive: true });
  writeFileSync(paths.taskFile(fm.id), stringifyMarkdown({ ...fm }, body));
}

export function readTask(id: string) {
  return parseMarkdown<TaskFrontmatter>(readFileSync(paths.taskFile(id), "utf8"));
}

export function writeRecurring(fm: RecurringFrontmatter, body: string): void {
  mkdirSync(paths.recurringDir(), { recursive: true });
  writeFileSync(paths.recurringFile(fm.id), stringifyMarkdown({ ...fm }, body));
}

export function readRecurring(id: string) {
  return parseMarkdown<RecurringFrontmatter>(readFileSync(paths.recurringFile(id), "utf8"));
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

// ------------------------------------------------- attachments (files for Claude)
// Same machinery for tasks and recurring templates — only the base dir differs
// (tasks/<id>/attachments/ vs recurring/<id>/attachments/).

/** Reduce an uploaded filename to one safe path segment: basename only, no control
 *  chars, never empty/dot-only, length-capped with the extension preserved. */
export function safeAttachmentName(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  let name = basename(raw.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  name = name.replace(/^\.+/, ""); // no hidden/".." names
  if (!name) name = "file";
  if (name.length > 120) {
    const ext = extname(name).slice(0, 16);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

/** Resolve an attachment name to its on-disk path inside `dir`, or null when the
 *  name is not a plain segment (traversal) or the file doesn't exist. */
function attachmentPathIn(dir: string, name: string): string | null {
  if (!name || name !== safeAttachmentName(name) || name.includes("/") || name.includes("\\")) {
    return null;
  }
  const file = join(dir, name);
  return existsSync(file) ? file : null;
}

/** Save one uploaded file under `dir`. Filenames are sanitized and deduped
 *  (`shot.png` → `shot-2.png`); returns the stored attachment. */
function saveAttachmentIn(dir: string, rawName: string, bytes: Uint8Array): TaskAttachment {
  mkdirSync(dir, { recursive: true });
  const safe = safeAttachmentName(rawName);
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let name = safe;
  for (let n = 2; existsSync(join(dir, name)); n++) {
    name = `${stem}-${n}${ext}`;
  }
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return toAttachment(name, file);
}

/** List the attachments under `dir` (newest last). */
function listAttachmentsIn(dir: string): TaskAttachment[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => toAttachment(name, join(dir, name)))
    .sort((a, b) => a.addedAt - b.addedAt || a.name.localeCompare(b.name));
}

/** Delete one attachment under `dir`; false when it didn't exist (or was unsafe). */
function deleteAttachmentIn(dir: string, name: string): boolean {
  const file = attachmentPathIn(dir, name);
  if (!file) return false;
  rmSync(file);
  return true;
}

// Task attachments.
export function attachmentPath(id: string, name: string): string | null {
  return attachmentPathIn(paths.taskAttachmentsDir(id), name);
}
export function saveAttachment(id: string, rawName: string, bytes: Uint8Array): TaskAttachment {
  return saveAttachmentIn(paths.taskAttachmentsDir(id), rawName, bytes);
}
export function listAttachments(id: string): TaskAttachment[] {
  return listAttachmentsIn(paths.taskAttachmentsDir(id));
}
export function deleteAttachment(id: string, name: string): boolean {
  return deleteAttachmentIn(paths.taskAttachmentsDir(id), name);
}

// Recurring-template attachments — copied onto every task the template creates.
export function recurringAttachmentPath(id: string, name: string): string | null {
  return attachmentPathIn(paths.recurringAttachmentsDir(id), name);
}
export function saveRecurringAttachment(
  id: string,
  rawName: string,
  bytes: Uint8Array,
): TaskAttachment {
  return saveAttachmentIn(paths.recurringAttachmentsDir(id), rawName, bytes);
}
export function listRecurringAttachments(id: string): TaskAttachment[] {
  return listAttachmentsIn(paths.recurringAttachmentsDir(id));
}
export function deleteRecurringAttachment(id: string, name: string): boolean {
  return deleteAttachmentIn(paths.recurringAttachmentsDir(id), name);
}

// ------------------------------------------------- task outputs (files FROM agents)
// Non-code deliverables (reports, PDFs, exports) agents write for a task. The same
// safe-name/list machinery as attachments, but the data flows the other way: agents
// produce these files (they get the absolute dir in their composed context) and the
// UI links them so each opens directly from the task.

/** Ensure a task's outputs/ dir exists (called before execution so the agent can
 *  write into it without ceremony). */
export function ensureOutputsDir(id: string): string {
  const dir = paths.taskOutputsDir(id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function outputPath(id: string, name: string): string | null {
  return attachmentPathIn(paths.taskOutputsDir(id), name);
}
export function listOutputs(id: string): TaskAttachment[] {
  return listAttachmentsIn(paths.taskOutputsDir(id));
}
export function deleteOutput(id: string, name: string): boolean {
  return deleteAttachmentIn(paths.taskOutputsDir(id), name);
}

function toAttachment(name: string, file: string): TaskAttachment {
  const stat = statSync(file);
  return {
    name,
    path: file,
    size: stat.size,
    mimeType: Bun.file(file).type.split(";")[0] ?? "",
    addedAt: Math.round(stat.mtimeMs),
  };
}

// ------------------------------------------------- agent run reports (append-only)

/** Marker line carrying the machine-readable meta for one run entry. The human-
 *  readable heading + output follow it, so runs.md reads naturally in any editor
 *  while parsing never depends on the (agent-authored) output text. */
const RUN_MARKER = /^<!-- cadence:run (\{.*\}) -->$/;

/** Append one agent run's final output to the task's runs.md — the durable
 *  "what did each stage actually say/do" record (content truth; survives
 *  transcript GC). Never throws: recording must not break the pipeline. */
export function appendRunReport(id: string, report: import("@cadence/shared").TaskRunReport): void {
  try {
    mkdirSync(paths.taskDir(id), { recursive: true });
    const meta = JSON.stringify({
      at: report.at,
      role: report.role,
      status: report.status,
      costUsd: report.costUsd,
      sessionId: report.sessionId,
      model: report.model,
    });
    const heading = `## ${report.role} — ${report.status} (${new Date(report.at).toISOString()})`;
    const output = report.output.trim() || "(no output)";
    appendFileSync(paths.taskRuns(id), `<!-- cadence:run ${meta} -->\n${heading}\n\n${output}\n\n`);
  } catch (err) {
    console.warn(`[cadence] run report skipped for ${id}:`, (err as Error).message);
  }
}

/** Read a task's run reports (newest last); [] when none. Tolerates hand edits —
 *  anything before the first marker or with unparseable meta is skipped. */
export function readRunReports(id: string): import("@cadence/shared").TaskRunReport[] {
  const file = paths.taskRuns(id);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const reports: import("@cadence/shared").TaskRunReport[] = [];
  let current: import("@cadence/shared").TaskRunReport | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current) {
      // Drop our own decorative heading (first non-empty line starting with "## ").
      const text = body.join("\n").trim();
      current.output = text.startsWith("## ") ? text.slice(text.indexOf("\n") + 1).trim() : text;
      reports.push(current);
    }
    current = null;
    body = [];
  };
  for (const line of lines) {
    const m = line.match(RUN_MARKER);
    if (m) {
      flush();
      try {
        const meta = JSON.parse(m[1] as string) as Partial<import("@cadence/shared").TaskRunReport>;
        current = {
          at: typeof meta.at === "number" ? meta.at : 0,
          role: meta.role ?? "agent",
          status: meta.status === "failed" || meta.status === "needs_input" ? meta.status : "done",
          costUsd: typeof meta.costUsd === "number" ? meta.costUsd : null,
          sessionId: meta.sessionId ?? null,
          model: meta.model ?? null,
          output: "",
        };
      } catch {
        current = null; // unparseable meta — skip this entry
      }
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  return reports;
}

// ---------------------------------------------- review artifacts (6.5.c/d, JSON)

/** Read the reviewer's findings artifact; null when no review ran yet. */
export function readReviewFindings(id: string): import("@cadence/shared").ReviewFindings | null {
  const file = paths.taskReviewFindings(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as import("@cadence/shared").ReviewFindings;
  } catch {
    return null;
  }
}

export function writeReviewFindings(id: string, findings: import("@cadence/shared").ReviewFindings): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(paths.taskReviewFindings(id), `${JSON.stringify(findings, null, 2)}\n`);
}

/** Read the responder's proposal artifact; null when none yet. */
export function readReviewProposal(id: string): import("@cadence/shared").ReviewProposal | null {
  const file = paths.taskReviewProposal(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as import("@cadence/shared").ReviewProposal;
  } catch {
    return null;
  }
}

export function writeReviewProposal(id: string, proposal: import("@cadence/shared").ReviewProposal): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(paths.taskReviewProposal(id), `${JSON.stringify(proposal, null, 2)}\n`);
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

// ------------------------------------------------------ task delivery (delivery.md)

/** Read a task's Delivery result (delivery.md); null if not delivered yet. */
export function readDelivery(id: string): DeliveryResult | null {
  const file = paths.taskDelivery(id);
  if (!existsSync(file)) return null;
  const { data, body } = parseMarkdown<Partial<DeliveryResult>>(readFileSync(file, "utf8"));
  return {
    mode: data.mode ?? "branch_summary",
    summary: (data.summary ?? body ?? "").trim(),
    branch: data.branch ?? null,
    prUrl: data.prUrl ?? null,
    outputs: data.outputs ?? null,
  };
}

/** Write a task's Delivery result to delivery.md (frontmatter + the summary body). */
export function writeDelivery(id: string, result: DeliveryResult): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(
    paths.taskDelivery(id),
    stringifyMarkdown(
      {
        mode: result.mode,
        branch: result.branch,
        prUrl: result.prUrl,
        outputs: result.outputs ?? null,
        summary: result.summary,
      },
      `# Delivery\n\n${result.summary}`,
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
    forgeOverride: data.forgeOverride ?? null,
    defaultModel: data.defaultModel ?? null,
    defaultPermissionMode: data.defaultPermissionMode ?? "auto",
    defaultDeliveryMode: data.defaultDeliveryMode ?? "branch_summary",
    autonomy: data.autonomy ?? null,
    worktreesEnabled: data.worktreesEnabled ?? false,
    worktreeCheck: data.worktreeCheck ? JSON.stringify(data.worktreeCheck) : null,
    worktreeCheckRun: data.worktreeCheckRun ? JSON.stringify(data.worktreeCheckRun) : null,
    systemPrompt: body || null,
    agentPrompts:
      data.agentPrompts && Object.keys(data.agentPrompts).length ? JSON.stringify(data.agentPrompts) : null,
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
    prUrl: data.prUrl ?? null,
    gitContext: data.gitContext ? JSON.stringify(data.gitContext) : null,
    taskType: data.taskType ?? "standard",
    reviewDirection: data.reviewDirection ?? null,
    reviewRef: data.reviewRef ?? null,
    permissionMode: data.permissionMode ?? null,
    parentTaskId: data.parentTask ?? null,
    updatedAt: Date.now(),
  };
  db.insert(tasks)
    .values(row)
    .onConflictDoUpdate({ target: tasks.id, set: row })
    .run();

  // Sync this task's incoming dependency edges (blockedBy) into task_deps. Each
  // task owns its own incoming edges; a blocker that isn't indexed yet is skipped
  // (re-synced when this task is next reindexed), so order never breaks the FK.
  db.delete(taskDeps).where(eq(taskDeps.blockedTaskId, data.id)).run();
  for (const blockerId of data.blockedBy ?? []) {
    if (blockerId === data.id) continue;
    const exists = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, blockerId)).get();
    if (!exists) continue;
    db.insert(taskDeps)
      .values({ blockerTaskId: blockerId, blockedTaskId: data.id })
      .onConflictDoNothing()
      .run();
  }
}

/** Reindex one recurring template's markdown into the index (body = the task
 *  description template). nextRunAt is derived here: the next occurrence after
 *  the last trigger (or creation), null while paused — so the scheduler's
 *  due-check is a plain indexed comparison. */
export function reindexRecurring(db: Db, id: string): void {
  const { data, body } = readRecurring(id);

  const projectId = data.project
    ? (db.select({ id: projects.id }).from(projects).where(eq(projects.slug, data.project)).get()
        ?.id ?? null)
    : null;
  const lastTriggeredAt = toEpochMs(data.lastTriggeredAt);
  const createdAt = toEpochMs(data.createdAt) ?? Date.now();
  const paused = data.paused ?? false;
  const schedule = {
    cadence: (data.cadence ?? "daily") as RecurringCadence,
    dayOfWeek: data.dayOfWeek ?? null,
    dayOfMonth: data.dayOfMonth ?? null,
    time: data.time ?? "09:00",
  };

  const row = {
    id: data.id,
    title: data.title,
    body,
    cadence: schedule.cadence,
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    time: schedule.time,
    projectId,
    priority: data.priority ?? null,
    paused,
    lastTriggeredAt,
    lastTaskId: data.lastTaskId ?? null,
    nextRunAt: paused ? null : computeNextRun(schedule, lastTriggeredAt ?? createdAt),
    createdAt,
    updatedAt: Date.now(),
  };
  db.insert(recurringTasks)
    .values(row)
    .onConflictDoUpdate({ target: recurringTasks.id, set: row })
    .run();
}

/** Full reindex from disk: projects + fleets first (so task links resolve), then
 *  tasks + recurring templates. Recovers the entire index from the markdown
 *  source of truth. */
export function reindexAll(db: Db): void {
  for (const file of listMarkdown(paths.projectsDir())) reindexProject(db, basenameNoExt(file));
  for (const file of listMarkdown(paths.fleetsDir())) reindexFleet(db, basenameNoExt(file));
  for (const id of listTaskIds()) reindexTask(db, id);
  for (const id of listRecurringIds()) reindexRecurring(db, id);
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

export function listRecurringIds(): string[] {
  return listMarkdown(paths.recurringDir()).map(basenameNoExt);
}
