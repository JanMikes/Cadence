import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { fleets } from "./db/schema";
import { getProjectById } from "./projects";
import { readContext, readSettings, readSpec } from "./store/store";

export interface ContextScope {
  taskId?: string | null;
  projectId?: string | null;
  fleetId?: string | null;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}`;
}

/**
 * Compose the layered context for a Claude run (spec §7.1), most-general first so
 * later (more specific) layers win:
 *   Global → Project systemPrompt → Fleet systemPrompt → Task spec → Task context.
 * The result is passed via `--append-system-prompt` at spawn. (Repo CLAUDE.md is
 * loaded natively by claude; Q&A answers + role prompt arrive in Phase 2.)
 * Returns "" when there's nothing to add.
 */
export function composeContext(db: Db, scope: ContextScope): string {
  const sections: string[] = [];

  const global = readSettings().global.systemPrompt;
  if (global?.trim()) sections.push(section("Global context", global));

  if (scope.projectId) {
    const project = getProjectById(db, scope.projectId);
    if (project?.systemPrompt?.trim()) {
      sections.push(section(`Project: ${project.name}`, project.systemPrompt));
    }
  }

  if (scope.fleetId) {
    const fleet = db.select().from(fleets).where(eq(fleets.id, scope.fleetId)).get();
    if (fleet?.systemPrompt?.trim()) sections.push(section(`Fleet: ${fleet.name}`, fleet.systemPrompt));
  }

  if (scope.taskId) {
    const spec = readSpec(scope.taskId);
    if (spec.trim()) sections.push(section("Task spec & acceptance criteria", spec));
    const ctx = readContext(scope.taskId);
    if (ctx.trim()) sections.push(section("Task context (free-form notes)", ctx));
  }

  return sections.join("\n\n");
}
