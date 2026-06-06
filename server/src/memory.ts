import type { LearnedEntry, MemoryFile } from "@cadence/shared";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { paths } from "./store/paths";

/**
 * The markdown memory layer (spec §8.1): Cadence's self-written context. Global
 * memory (`~/.cadence/memory/*.md` incl. MEMORY.md + communication.md) is
 * cross-project; per-project memory lives under `memory/projects/<slug>.md`.
 * All of it composes into agent runs (see context.ts). Hand-editable markdown.
 */

/** Sanitize a memory file name to a safe slug (no path traversal). */
export function safeName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "").slice(0, 60);
}

/** Top-level global memory files (name without extension + content), MEMORY first. */
export function listMemoryFiles(): MemoryFile[] {
  const dir = paths.memoryDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)));
  return files.map((f) => ({
    name: f.replace(/\.md$/, ""),
    content: readFileSync(paths.memoryFile(f.replace(/\.md$/, "")), "utf8"),
  }));
}

export function writeMemoryFile(name: string, content: string): MemoryFile {
  const safe = safeName(name) || "note";
  mkdirSync(paths.memoryDir(), { recursive: true });
  writeFileSync(paths.memoryFile(safe), content.endsWith("\n") ? content : `${content}\n`);
  return { name: safe, content };
}

export function readProjectMemory(slug: string): string {
  const file = paths.projectMemoryFile(slug);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function writeProjectMemory(slug: string, content: string): void {
  mkdirSync(paths.projectMemoryDir(), { recursive: true });
  writeFileSync(paths.projectMemoryFile(slug), content.endsWith("\n") ? content : `${content}\n`);
}

/** Append a bullet note to a global memory file (creating it if needed). */
export function appendMemoryNote(name: string, note: string): void {
  const safe = safeName(name) || "learned";
  const existing = existsSync(paths.memoryFile(safe)) ? readFileSync(paths.memoryFile(safe), "utf8") : "";
  const base = existing.trim() ? `${existing.trimEnd()}\n` : `# ${safe}\n\n`;
  writeMemoryFile(safe, `${base}- ${note.trim()}\n`);
}

/** Append a bullet note to a project's memory file (creating it if needed). */
export function appendProjectMemoryNote(slug: string, note: string): void {
  const existing = readProjectMemory(slug);
  const base = existing.trim() ? `${existing.trimEnd()}\n` : `# ${slug} memory\n\n`;
  writeProjectMemory(slug, `${base}- ${note.trim()}\n`);
}

/** The "what Cadence learned" feed: each bullet of a learned memory file, reviewable. */
export function listLearnedEntries(name = "learned"): LearnedEntry[] {
  const file = paths.memoryFile(safeName(name));
  if (!existsSync(file)) return [];
  const entries: LearnedEntry[] = [];
  let index = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^-\s+(.*)$/);
    if (m) entries.push({ index: index++, text: (m[1] ?? "").trim() });
  }
  return entries;
}

/** Revert (remove) the index-th learned bullet from a memory file. */
export function revertLearnedEntry(name: string, index: number): boolean {
  const file = paths.memoryFile(safeName(name));
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  let bullet = 0;
  let removed = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      if (bullet === index) {
        removed = true;
        bullet++;
        continue; // drop this entry
      }
      bullet++;
    }
    out.push(line);
  }
  if (removed) writeFileSync(file, out.join("\n"));
  return removed;
}

/** All global memory, concatenated for context composition (each file labeled). */
export function readGlobalMemory(): string {
  return listMemoryFiles()
    .map((f) => f.content.trim())
    .filter(Boolean)
    .join("\n\n");
}
