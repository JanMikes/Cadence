import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { fleets } from "./db/schema";
import { projectForgeStatus } from "./forge";
import { readGlobalMemory, readProjectMemory } from "./memory";
import { getProjectById } from "./projects";
import { paths } from "./store/paths";
import { listAttachments, listOutputs, readContext, readSettings, readSpec } from "./store/store";

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

  const globalMemory = readGlobalMemory();
  if (globalMemory.trim()) sections.push(section("Memory (learned, cross-project)", globalMemory));

  if (scope.projectId) {
    const project = getProjectById(db, scope.projectId);
    if (project?.systemPrompt?.trim()) {
      sections.push(section(`Project: ${project.name}`, project.systemPrompt));
    }
    if (project) {
      const projectMemory = readProjectMemory(project.slug);
      if (projectMemory.trim()) {
        sections.push(section(`Project memory: ${project.name}`, projectMemory));
      }
      // Forge capability (§6.4.f, tell-don't-hardcode): agents learn whether gh/glab is
      // usable here so they can open PRs / read issues / check CI when relevant. The
      // probe is cached (10 min), so this stays cheap per run.
      if (project.gitRemote) {
        const forge = projectForgeStatus(project.gitRemote, project.forgeOverride);
        if (forge.remote?.forge) {
          const label = forge.remote.forge === "github" ? "GitHub" : "GitLab";
          const cli = forge.cli;
          const ready = cli?.installed && cli.authenticated;
          sections.push(
            section(
              "Repository forge",
              `This repo is ${forge.remote.host}/${forge.remote.owner}/${forge.remote.repo} (${label}). ` +
                (ready
                  ? `The \`${cli.cli}\` CLI is installed and authenticated${cli.account ? ` as ${cli.account}` : ""} — you may use it for PR/MR, issue and CI operations when relevant.`
                  : `The \`${cli?.cli ?? (forge.remote.forge === "github" ? "gh" : "glab")}\` CLI is not ready here — avoid forge API operations.`),
            ),
          );
        }
      }
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
    // Attached files travel as absolute paths — the same way a path pasted into the
    // claude terminal works. The Read tool renders images, so screenshots "just work".
    const attachments = listAttachments(scope.taskId);
    if (attachments.length) {
      sections.push(
        section(
          "Task attachments (files from the user)",
          "The user attached these files as context for this task. Read them before starting — " +
            "the Read tool renders images (screenshots, mockups) as well as text:\n\n" +
            attachments.map((a) => `- ${a.path}${a.mimeType ? ` (${a.mimeType})` : ""}`).join("\n"),
        ),
      );
    }
    // Non-code deliverables (§7: outputs, not commits). Every stage sees the same
    // rule, so the planner plans for it, the implementer writes there, the verifier
    // checks there, and delivery reports it.
    const outputsDir = paths.taskOutputsDir(scope.taskId);
    const outputs = listOutputs(scope.taskId);
    sections.push(
      section(
        "Task outputs (non-code deliverables)",
        "If this task's deliverable includes files that are NOT source-code changes — reports, " +
          "PDFs, generated documents, exports, datasets — save them as plain files directly in " +
          "this directory (create it if needed), NOT inside the repository:\n\n" +
          `${outputsDir}\n\n` +
          "Never commit generated assets to the repo. Every file in this directory is linked on " +
          "the task automatically, so the user opens it directly from the task." +
          (outputs.length
            ? "\n\nOutput files saved so far:\n" +
              outputs.map((o) => `- ${o.path}${o.mimeType ? ` (${o.mimeType})` : ""}`).join("\n")
            : ""),
      ),
    );
  }

  return sections.join("\n\n");
}
