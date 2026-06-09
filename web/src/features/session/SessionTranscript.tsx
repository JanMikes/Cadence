import type { TranscriptEntry } from "@cadence/shared";
import { useQuery } from "@tanstack/react-query";
import { getTranscript } from "../../lib/api";
import { cn } from "../../lib/utils";

/** The on-disk transcript for a session (read-only history). */
export function SessionTranscript({ sessionId }: { sessionId: string }) {
  const t = useQuery({
    queryKey: ["transcript", sessionId],
    queryFn: () => getTranscript(sessionId),
  });

  return (
    <div className="flex flex-col gap-2">
      {t.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {t.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transcript on disk yet for this session.</p>
      ) : null}
      {t.data?.map((e, i) => (
        <TranscriptLine key={`${e.uuid ?? "x"}-${i}`} entry={e} />
      ))}
    </div>
  );
}

function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  const sidechain = entry.isSidechain;
  return (
    <div className={cn(sidechain && "ml-5 border-l-2 border-primary/30 pl-3")}>
      <div className="mb-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium">{entry.role}</span>
        {sidechain ? <span className="rounded bg-primary/15 px-1 text-primary">subagent</span> : null}
        {entry.kind !== "text" ? <span>· {entry.kind}</span> : null}
      </div>
      {entry.kind === "tool_use" ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-1.5 font-mono text-xs">
          🔧 {entry.toolName}
        </div>
      ) : (
        <div
          className={cn(
            "whitespace-pre-wrap rounded-md px-3 py-2 text-sm",
            entry.kind === "thinking" ? "bg-muted/30 italic text-muted-foreground" : "bg-card",
          )}
        >
          {entry.text}
        </div>
      )}
    </div>
  );
}
