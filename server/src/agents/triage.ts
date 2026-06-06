import type { AgentResult } from "@cadence/shared";
import type { Db } from "../db/client";
import { listProjects } from "../projects";
import { appendContext } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
import { type AgentRunOptions, runAgent } from "./runner";

export type AgentRunner = (opts: AgentRunOptions) => Promise<AgentResult>;

/** The JSON the Triage agent returns (agent-prompts.md §1). */
export interface TriageJson {
  sufficiency?: "ok" | "insufficient";
  needFromUser?: string | null;
  restatement?: string;
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
): string {
  const projects = projectList.length
    ? projectList.map((p) => `${p.slug} (${p.name})`).join(", ")
    : "(none yet)";
  return [
    "You are the Triage agent for a personal task platform. Given a raw, possibly-messy task the user",
    "dumped into their inbox, do a fast first pass. Do NOT explore code. Output JSON only.",
    "",
    "Decide: which known project this belongs to (or null); a priority (P0..P3); a deadline if one is",
    "implied (YYYY-MM-DD or null); 2-4 labels; and a one-line restatement of the goal.",
    'If too vague to even route or restate, set sufficiency:"insufficient" and say what you need.',
    "",
    `Known projects: ${projects}.`,
    "",
    "Respond with ONLY this JSON shape:",
    '{"sufficiency":"ok|insufficient","needFromUser":"string|null","restatement":"string",',
    '"projectSlug":"string|null","priority":"P0|P1|P2|P3","deadline":"YYYY-MM-DD|null","labels":["string"]}',
    "",
    `TASK TITLE: ${raw.title}`,
    raw.body ? `TASK BODY: ${raw.body}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Apply a parsed triage result to the task (deterministic; no model). */
export function applyTriage(db: Db, taskId: string, j: TriageJson): TriageOutcome {
  if (j.sufficiency === "insufficient") {
    updateTask(db, taskId, { status: "needs_feedback" });
    const need = j.needFromUser?.trim();
    if (need) appendContext(taskId, `Triage needs more info: ${need}`);
    return { ran: true, status: "needs_feedback", needFromUser: need };
  }

  const patch: Parameters<typeof updateTask>[2] = { status: "triaged" };
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
  );
  const result = await run({
    cwd: resolveTaskCwd(db, taskId),
    role: "triage",
    prompt,
    permissionMode: "plan",
  });

  const j = (result.json ?? null) as TriageJson | null;
  if (!j || typeof j !== "object") return { ran: false }; // couldn't parse — leave in Inbox
  return applyTriage(db, taskId, j);
}
