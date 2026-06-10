import type { AgentResult } from "@cadence/shared";
import type { Db } from "../db/client";
import { withReadAccess } from "../project-locks";
import { listProjects } from "../projects";
import { appendContext } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
import { getAgentPrompt, renderTemplate, TITLE_NAMING_INSTRUCTION } from "./prompts";
import { type AgentRunOptions, runAgent } from "./runner";

export type AgentRunner = (opts: AgentRunOptions) => Promise<AgentResult>;

/** The JSON the Triage agent returns (agent-prompts.md §1). */
export interface TriageJson {
  sufficiency?: "ok" | "insufficient";
  needFromUser?: string | null;
  restatement?: string;
  /** A proper task title — requested when capture was description-only. */
  title?: string;
  projectSlug?: string | null;
  fleetName?: string | null;
  isMultiRepo?: boolean;
  priority?: string;
  deadline?: string | null;
  labels?: string[];
}

export interface TriageOutcome {
  ran: boolean;
  status?: string; // resulting task status
  restatement?: string;
  needFromUser?: string;
}

export function buildTriagePrompt(
  raw: { title: string; body: string },
  projectList: Array<{ slug: string; name: string }>,
  opts: { titleNeeded?: boolean } = {},
): string {
  // The instructions live in the editable prompt registry (§6.3.a); this builder only
  // computes the variables. Conditional fragments are whole-line vars — empty → line drops.
  return renderTemplate(getAgentPrompt("triage"), {
    title: raw.title,
    bodyLine: raw.body ? `TASK BODY: ${raw.body}` : "",
    projects: projectList.length
      ? projectList.map((p) => `${p.slug} (${p.name})`).join(", ")
      : "(none yet)",
    titleInstruction: opts.titleNeeded ? TITLE_NAMING_INSTRUCTION : "",
    titleField: opts.titleNeeded ? '"title":"string",' : "",
  });
}

/** Apply a parsed triage result to the task (deterministic; no model). */
export function applyTriage(db: Db, taskId: string, j: TriageJson): TriageOutcome {
  // The agent names the task only when the title is still a derived placeholder —
  // a user-written title is never overwritten (propose, don't impose).
  const agentTitle =
    getTaskDetail(db, taskId)?.titleGenerated && j.title?.trim() ? j.title.trim() : undefined;

  if (j.sufficiency === "insufficient") {
    updateTask(db, taskId, { status: "needs_feedback", ...(agentTitle && { title: agentTitle }) });
    const need = j.needFromUser?.trim();
    if (need) appendContext(taskId, `Triage needs more info: ${need}`);
    return { ran: true, status: "needs_feedback", needFromUser: need };
  }

  const patch: Parameters<typeof updateTask>[2] = { status: "triaged" };
  if (agentTitle) patch.title = agentTitle;
  if (j.projectSlug) patch.project = j.projectSlug;
  if (j.priority) patch.priority = j.priority;
  if (Array.isArray(j.labels) && j.labels.length) patch.labels = j.labels;
  if (j.deadline) {
    const ms = Date.parse(j.deadline);
    if (!Number.isNaN(ms)) patch.deadline = ms;
  }
  updateTask(db, taskId, patch);
  if (j.restatement?.trim()) appendContext(taskId, `Triage restatement: ${j.restatement.trim()}`);
  return { ran: true, status: "triaged", restatement: j.restatement?.trim() };
}

/**
 * Run the Triage agent on a freshly-captured task: compose the prompt, run a
 * one-shot Haiku agent (read-only "plan" mode), parse its JSON, and apply it.
 * `run` is injectable so tests use the mock (no real model). Returns the outcome.
 */
export async function runTriage(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<TriageOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false };

  const prompt = buildTriagePrompt(
    { title: task.title, body: task.body },
    listProjects(db).map((p) => ({ slug: p.slug, name: p.name })),
    { titleNeeded: task.titleGenerated },
  );
  // Read lock: queued behind an in-place execution so triage never reads a
  // half-written task branch; shared with the other read stages.
  const result = await withReadAccess(db, taskId, () =>
    run({
      cwd: resolveTaskCwd(db, taskId),
      taskId,
      role: "triage",
      prompt,
      permissionMode: "plan",
    }),
  );

  const j = (result.json ?? null) as TriageJson | null;
  if (!j || typeof j !== "object") return { ran: false }; // couldn't parse — leave in Inbox
  return applyTriage(db, taskId, j);
}
