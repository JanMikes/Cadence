import type { LiveSession, TranscriptEntry } from "@cadence/shared";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of Claude Code's on-disk state. Overridable via CADENCE_CLAUDE_DIR (tests). */
export function claudeDir(): string {
  return process.env.CADENCE_CLAUDE_DIR ?? join(homedir(), ".claude");
}

/**
 * ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl (control surfaces §2.1).
 * `<encoded-cwd>` = the REAL (symlink-resolved) cwd with every "/" replaced by
 * "-" — claude resolves e.g. /tmp → /private/tmp on macOS before encoding.
 */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* dir may not exist yet — fall back to the raw path */
  }
  const encoded = real.replace(/\//g, "-");
  return join(claudeDir(), "projects", encoded, `${sessionId}.jsonl`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; ESRCH = no such process.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Read the liveness oracle (~/.claude/sessions/*.json), flagging stale pids. */
export function readLiveSessions(): LiveSession[] {
  const dir = join(claudeDir(), "sessions");
  if (!existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      const pid = Number(d.pid);
      if (!Number.isFinite(pid)) continue;
      out.push({
        pid,
        sessionId: String(d.sessionId ?? ""),
        cwd: String(d.cwd ?? ""),
        status: String(d.status ?? "unknown"),
        kind: String(d.kind ?? "unknown"),
        version: d.version != null ? String(d.version) : null,
        startedAt: typeof d.startedAt === "number" ? d.startedAt : null,
        updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : null,
        alive: pidAlive(pid),
      });
    } catch {
      // skip malformed oracle files
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

function blockEntries(line: RawLine): TranscriptEntry[] {
  const base = {
    uuid: line.uuid ?? null,
    parentUuid: line.parentUuid ?? null,
    role: line.message?.role ?? line.type ?? "system",
    isSidechain: line.isSidechain === true,
    timestamp: line.timestamp ?? null,
  };
  const content = line.message?.content;

  if (typeof content === "string") {
    return [{ ...base, kind: "text", text: content, toolName: null }];
  }
  if (!Array.isArray(content)) return [];

  return (content as Array<Record<string, unknown>>).map((b) => {
    const type = b.type;
    if (type === "text") return { ...base, kind: "text" as const, text: String(b.text ?? ""), toolName: null };
    if (type === "thinking")
      return { ...base, kind: "thinking" as const, text: String(b.thinking ?? ""), toolName: null };
    if (type === "tool_use")
      return { ...base, kind: "tool_use" as const, text: null, toolName: String(b.name ?? "tool") };
    if (type === "tool_result") {
      const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return { ...base, kind: "tool_result" as const, text: t, toolName: null };
    }
    return { ...base, kind: "other" as const, text: null, toolName: null };
  });
}

/**
 * Parse a past transcript (.jsonl) into renderable entries. Only user/assistant
 * message lines carry content; pure-metadata lines (ai-title, mode, …) are
 * skipped. `isSidechain` marks subagent activity for nesting. `limit` keeps the
 * most recent N entries.
 */
export function readTranscript(path: string, opts: { limit?: number } = {}): TranscriptEntry[] {
  if (!existsSync(path)) return [];
  const entries: TranscriptEntry[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: RawLine;
    try {
      parsed = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    entries.push(...blockEntries(parsed));
  }
  return opts.limit && entries.length > opts.limit ? entries.slice(-opts.limit) : entries;
}
