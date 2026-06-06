import type { MemoryFile } from "@cadence/shared";
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

/** All global memory, concatenated for context composition (each file labeled). */
export function readGlobalMemory(): string {
  return listMemoryFiles()
    .map((f) => f.content.trim())
    .filter(Boolean)
    .join("\n\n");
}
