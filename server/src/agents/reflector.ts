import { desc } from "drizzle-orm";
import type { Db } from "../db/client";
import { suggestions } from "../db/schema";
import { appendMemoryNote, appendProjectMemoryNote } from "../memory";
import { getProject } from "../projects";
import { runAgent } from "./runner";
import type { AgentRunner } from "./triage";

/**
 * The Reflector / Librarian (spec §8.1): distill durable lessons from my
 * corrections (suggestion provenance — what I Edit/Override/Dismiss vs Accept)
 * into the markdown memory. A one-shot Haiku; `run` is injectable so tests use
 * the mock. Propose-don't-impose: it appends notes, the human prunes memory.
 */
export interface ReflectorJson {
  lessons?: Array<{ scope?: string; note?: string }>;
}

export interface ReflectorOutcome {
  ran: boolean;
  lessons?: number;
  reason?: string;
}

const CORRECTIONS = new Set(["edited", "overridden", "dismissed", "confirmed"]);

/** Recent resolved suggestions, summarized as correction signals for the prompt. */
export function gatherSignals(db: Db, limit = 50): string[] {
  return db
    .select()
    .from(suggestions)
    .orderBy(desc(suggestions.resolvedAt))
    .limit(limit)
    .all()
    .filter((s) => s.resolvedAt != null && CORRECTIONS.has(s.status))
    .map((s) => `${s.status} ${s.entityType}.${s.field} = ${s.suggestedValue}`);
}

export function buildReflectorPrompt(signals: string[]): string {
  return [
    "You are the Reflector. Below are recent decisions I made on Cadence's suggestions (what I",
    "Accepted/Edited/Overrode/Dismissed). Distill only DURABLE, GENERAL lessons worth remembering —",
    "recurring patterns, not one-offs. Each lesson is one concise sentence. If nothing is durable,",
    "return an empty list. Output JSON only.",
    "",
    'Respond with ONLY: {"lessons":[{"scope":"global|<project-slug>","note":"string"}]}',
    "",
    "SIGNALS:",
    ...signals.map((s) => `- ${s}`),
  ].join("\n");
}

/** Append each lesson to the right memory file (global, or a project's). */
export function applyReflection(db: Db, j: ReflectorJson): number {
  let applied = 0;
  for (const lesson of j.lessons ?? []) {
    const note = lesson.note?.trim();
    if (!note) continue;
    const scope = lesson.scope?.trim();
    if (scope && scope !== "global" && getProject(db, scope)) {
      appendProjectMemoryNote(scope, note);
    } else {
      appendMemoryNote("learned", note);
    }
    applied++;
  }
  return applied;
}

export async function runReflector(
  db: Db,
  run: AgentRunner = runAgent,
): Promise<ReflectorOutcome> {
  const signals = gatherSignals(db);
  if (signals.length === 0) return { ran: false, reason: "no correction signals yet" };

  const result = await run({
    cwd: process.cwd(),
    role: "reflector",
    prompt: buildReflectorPrompt(signals),
    permissionMode: "plan",
  });

  const j = (result.json ?? null) as ReflectorJson | null;
  if (!j || typeof j !== "object") return { ran: false, reason: "reflector returned no JSON" };
  return { ran: true, lessons: applyReflection(db, j) };
}
