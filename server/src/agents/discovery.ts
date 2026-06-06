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

function bullets(items: string[] | undefined): string {
  return (items ?? []).map((i) => `- ${i}`).join("\n") || "- (none)";
}

/** Render the discovery result into spec.md. */
export function specMarkdown(j: DiscoveryJson): string {
  const approaches = (j.approaches ?? [])
    .map((a) => `- **${a.name ?? "option"}**${a.recommended ? " (recommended)" : ""}: ${a.summary ?? ""}`)
    .join("\n");
  const criteria = (j.acceptanceCriteria ?? []).map((c) => `- [ ] ${c}`).join("\n") || "- [ ] (none)";
  return [
    "# Spec",
    j.spec?.trim() ?? "",
    "## Scope",
    `**In:** ${(j.scope?.in ?? []).join(", ") || "—"}`,
    `**Out:** ${(j.scope?.out ?? []).join(", ") || "—"}`,
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
    const need = j.needFromUser?.trim();
    if (need) appendContext(taskId, `Discovery needs more info: ${need}`);
    return { ran: true, status: "needs_feedback", needFromUser: need };
  }

  writeSpec(taskId, specMarkdown(j));
  const unknowns = (j.unknowns ?? []).filter(Boolean);
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
    role: "discovery",
    prompt: buildDiscoveryPrompt({ title: task.title, body: task.body }),
    permissionMode: "plan",
    agentsJson: agentsJson(DISCOVERY_SUBAGENTS),
  });

  const j = (result.json ?? null) as DiscoveryJson | null;
  if (!j || typeof j !== "object") return { ran: false };
  return applyDiscovery(db, taskId, j);
}
