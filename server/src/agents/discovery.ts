import type { Db } from "../db/client";
import { appendContext, writeSpec } from "../store/store";
import { getTaskDetail, resolveTaskCwd, updateTask } from "../tasks";
import { agentsJson } from "./library";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

/** The JSON the Discovery agent returns (agent-prompts.md §2). */
export interface DiscoveryJson {
  sufficiency?: "ok" | "insufficient";
  needFromUser?: string | null;
  spec?: string;
  scope?: { in?: string[]; out?: string[] };
  affectedFiles?: string[];
  approaches?: Array<{ name?: string; summary?: string; recommended?: boolean }>;
  risks?: string[];
  acceptanceCriteria?: string[];
  unknowns?: string[];
}

export interface DiscoveryOutcome {
  ran: boolean;
  status?: string;
  unknowns?: string[];
  needFromUser?: string;
}

/** Explorers injected per discovery run via --agents (read-only, §7.2/§7.3). */
const DISCOVERY_SUBAGENTS = ["explorer", "dependency-mapper"];

export function buildDiscoveryPrompt(task: { title: string; body: string }): string {
  return [
    "You are the Discovery agent. The task is assigned to a project whose working directory is your",
    "cwd. Explore the relevant code (READ-ONLY — you may delegate to the `explorer` and",
    "`dependency-mapper` subagents) and turn the task into an actionable spec. Produce: a crisp problem",
    "statement, scope (in/out), the files/areas likely affected, 1-3 approach options with a",
    "recommendation, risks, and CHECKABLE acceptance criteria. List any genuine unknowns that block a",
    "confident implementation. If still too vague to implement responsibly, set",
    'sufficiency:"insufficient" and state precisely what you need. Output JSON only.',
    "",
    "Respond with ONLY this JSON shape:",
    '{"sufficiency":"ok|insufficient","needFromUser":"string|null","spec":"markdown",',
    '"scope":{"in":["string"],"out":["string"]},"affectedFiles":["path"],',
    '"approaches":[{"name":"string","summary":"string","recommended":true}],',
    '"risks":["string"],"acceptanceCriteria":["string"],"unknowns":["string"]}',
    "",
    `TASK TITLE: ${task.title}`,
    task.body ? `TASK BODY: ${task.body}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Coerce a model-returned value to text. Real models sometimes return `spec` as a structured
 *  object/array instead of the requested markdown string — render it readably instead of crashing. */
function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;
  } catch {
    return String(v);
  }
}

/** Coerce a model-returned value to a string list (tolerates a single value or non-string items). */
function asList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
}

function bullets(items: unknown): string {
  return asList(items).map((i) => `- ${i}`).join("\n") || "- (none)";
}

/** Render the discovery result into spec.md. Total: never throws on schema drift. */
export function specMarkdown(j: DiscoveryJson): string {
  const approaches = (Array.isArray(j.approaches) ? j.approaches : [])
    .map((a) => `- **${a?.name ?? "option"}**${a?.recommended ? " (recommended)" : ""}: ${asText(a?.summary)}`)
    .join("\n");
  const criteria = asList(j.acceptanceCriteria).map((c) => `- [ ] ${c}`).join("\n") || "- [ ] (none)";
  return [
    "# Spec",
    asText(j.spec).trim(),
    "## Scope",
    `**In:** ${asList(j.scope?.in).join(", ") || "—"}`,
    `**Out:** ${asList(j.scope?.out).join(", ") || "—"}`,
    "## Affected files",
    bullets(j.affectedFiles),
    "## Approaches",
    approaches || "- (none)",
    "## Risks",
    bullets(j.risks),
    "## Acceptance criteria",
    criteria,
    "## Unknowns",
    bullets(j.unknowns),
  ].join("\n\n");
}

/** Apply a parsed discovery result: write spec.md + set the task's status. */
export function applyDiscovery(db: Db, taskId: string, j: DiscoveryJson): DiscoveryOutcome {
  if (j.sufficiency === "insufficient") {
    updateTask(db, taskId, { status: "needs_feedback" });
    const need = asText(j.needFromUser).trim() || undefined;
    if (need) appendContext(taskId, `Discovery needs more info: ${need}`);
    return { ran: true, status: "needs_feedback", needFromUser: need };
  }

  writeSpec(taskId, specMarkdown(j));
  const unknowns = asList(j.unknowns).filter(Boolean);
  // Unknowns remain → stay in Refining for the Questioner (2.5) to ask; else Ready.
  const status = unknowns.length ? "refining" : "ready";
  updateTask(db, taskId, { status });
  return { ran: true, status, unknowns };
}

/**
 * Run Discovery on a task: mark it Refining, run a one-shot Sonnet agent in the
 * task's cwd (read-only) with the explorer subagents injected via --agents, parse
 * its JSON, and apply it. `run` is injectable so tests use the mock (no real model).
 */
export async function runDiscovery(
  db: Db,
  taskId: string,
  run: AgentRunner = runAgent,
): Promise<DiscoveryOutcome> {
  const task = getTaskDetail(db, taskId);
  if (!task) return { ran: false };

  updateTask(db, taskId, { status: "refining" });
  const result = await run({
    cwd: resolveTaskCwd(db, taskId),
    taskId,
    role: "discovery",
    prompt: buildDiscoveryPrompt({ title: task.title, body: task.body }),
    permissionMode: "plan",
    agentsJson: agentsJson(DISCOVERY_SUBAGENTS),
  });

  const j = (result.json ?? null) as DiscoveryJson | null;
  // The model didn't return usable JSON (or the run errored) — DON'T strand the task in Refining.
  // Surface it as Needs-Feedback with a visible note so it's recoverable, not silently stuck.
  if (!j || typeof j !== "object") {
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(
      taskId,
      "Discovery couldn't turn the agent's response into a spec (no parseable JSON). " +
        "Add more detail to the task, or run Claude on it manually.",
    );
    return { ran: true, status: "needs_feedback" };
  }
  try {
    return applyDiscovery(db, taskId, j);
  } catch (err) {
    updateTask(db, taskId, { status: "needs_feedback" });
    appendContext(taskId, `Discovery failed to apply its result: ${(err as Error).message}. Add detail or run Claude manually.`);
    return { ran: true, status: "needs_feedback" };
  }
}
