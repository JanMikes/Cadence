import type { TranscriptHit } from "@cadence/shared";
import { existsSync, readFileSync } from "node:fs";
import type { Db } from "./db/client";
import { listSessions } from "./sessions";
import { readTranscript } from "./transcripts";

/**
 * Search across session transcripts (spec §10). Scans the recorded sessions'
 * `*.jsonl` on demand — no stale index to maintain for external, ever-changing
 * ~/.claude files. A cheap whole-file substring gate avoids parsing non-matches;
 * a clean snippet comes from the parsed user/assistant text.
 */
export function searchTranscripts(db: Db, query: string, limit = 20): TranscriptHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: TranscriptHit[] = [];
  for (const s of listSessions(db)) {
    if (hits.length >= limit) break;
    const path = s.transcriptPath;
    if (!path || !existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!content.toLowerCase().includes(q)) continue; // gate before parsing
    const snippet = firstSnippet(path, q);
    if (snippet) hits.push({ sessionId: s.id, taskId: s.taskId, snippet });
  }
  return hits;
}

/** A trimmed, single-line snippet around the first match in the rendered text. */
function firstSnippet(path: string, q: string): string | null {
  for (const e of readTranscript(path)) {
    const text = e.text;
    if (!text) continue;
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + q.length + 80);
    const core = text.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
  }
  return null;
}
