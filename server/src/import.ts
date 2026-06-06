import type {
  EnrichResult,
  ImportCandidate,
  ImportSelection,
  Project,
} from "@cadence/shared";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db } from "./db/client";
import { createProject, getProjectByRootPath } from "./projects";
import { claudeDir } from "./transcripts";

function gitRemote(cwd: string): string | null {
  try {
    return (
      execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Read a project dir's real cwd + gitBranch from a transcript line (reliable — the
 *  encoded dir name is lossy for paths containing "-"). */
function cwdFromTranscripts(dirPath: string): { cwd: string; gitBranch: string | null } | null {
  let files: string[];
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dirPath, file), "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n").slice(0, 40)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const d = JSON.parse(line) as { cwd?: unknown; gitBranch?: unknown };
        if (typeof d.cwd === "string" && d.cwd) {
          return { cwd: d.cwd, gitBranch: typeof d.gitBranch === "string" ? d.gitBranch : null };
        }
      } catch {
        // skip malformed line
      }
    }
  }
  return null;
}

/** Scan ~/.claude/projects for real, on-disk working directories to propose as projects. */
export function scanClaudeProjects(db?: Db): ImportCandidate[] {
  const root = join(claudeDir(), "projects");
  if (!existsSync(root)) return [];

  const byCwd = new Map<string, ImportCandidate>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = cwdFromTranscripts(join(root, entry.name));
    if (!info) continue;
    const { cwd, gitBranch } = info;
    if (byCwd.has(cwd)) continue;
    try {
      if (!statSync(cwd).isDirectory()) continue;
    } catch {
      continue; // cwd no longer exists
    }
    byCwd.set(cwd, {
      cwd,
      name: basename(cwd),
      gitRemote: gitRemote(cwd),
      gitBranch,
      isGitRepo: existsSync(join(cwd, ".git")),
      alreadyImported: db ? Boolean(getProjectByRootPath(db, cwd)) : false,
    });
  }
  return [...byCwd.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Create projects for the selected candidates (skips ones already imported). */
export function importProjects(db: Db, selections: ImportSelection[]): Project[] {
  const created: Project[] = [];
  for (const sel of selections) {
    if (!sel.cwd || !sel.name?.trim()) continue;
    if (getProjectByRootPath(db, sel.cwd)) continue; // idempotent
    created.push(
      createProject(db, {
        name: sel.name.trim(),
        rootPath: sel.cwd,
        gitRemote: sel.gitRemote ?? gitRemote(sel.cwd) ?? undefined,
        systemPrompt: sel.systemPrompt,
      }),
    );
  }
  return created;
}

/**
 * Enrich a candidate with a one-shot `claude -p` (the "Claude-assisted" part).
 * Runs in the repo cwd and returns a short description. Injectable so tests/imports
 * don't require a real model.
 */
export async function claudeEnrich(cwd: string): Promise<EnrichResult> {
  const prompt =
    "In ONE short line, describe this repository (its purpose and main tech stack). Output only that line.";
  try {
    const out = execFileSync(process.env.CADENCE_CLAUDE_BIN ?? "claude", ["-p", prompt], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    }).trim();
    return { description: out || null, stack: null };
  } catch {
    return { description: null, stack: null };
  }
}
