import type { ImportCandidate } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { enrichCandidate, getImportCandidates, importProjects } from "../../lib/api";
import { cn } from "../../lib/utils";

/**
 * Project discovery: working directories Claude Code has seen, importable as projects.
 * Plain content (no card chrome) — rendered inside the "Import from Claude Code" modal.
 */
export function ImportProjects({ onImported }: { onImported?: () => void }) {
  const qc = useQueryClient();
  const candidates = useQuery({ queryKey: ["import-candidates"], queryFn: getImportCandidates });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [descs, setDescs] = useState<Record<string, string>>({});

  const toggle = (cwd: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(cwd) ? next.delete(cwd) : next.add(cwd);
      return next;
    });

  const doImport = useMutation({
    mutationFn: () => {
      const picks = (candidates.data ?? [])
        .filter((c) => selected.has(c.cwd))
        .map((c) => ({ cwd: c.cwd, name: c.name, gitRemote: c.gitRemote, systemPrompt: descs[c.cwd] }));
      return importProjects(picks);
    },
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["import-candidates"] });
      onImported?.();
    },
  });

  const enrich = useMutation({
    mutationFn: (cwd: string) => enrichCandidate(cwd),
    onSuccess: (res, cwd) => {
      if (res.description) setDescs((p) => ({ ...p, [cwd]: res.description as string }));
    },
  });

  const importable = (candidates.data ?? []).filter((c) => !c.alreadyImported);

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Working directories Claude Code has seen. Tick the ones to add as projects.
        </p>
        <LabeledIconButton
          icon={<RefreshCw />}
          label="Rescan"
          variant="ghost"
          size="sm"
          onClick={() => candidates.refetch()}
        />
      </div>

      {candidates.isLoading ? <p className="mt-3 text-xs text-muted-foreground">Scanning…</p> : null}
      {candidates.data && importable.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Nothing new to import.</p>
      ) : null}

      <ul className="mt-3 flex flex-col gap-1.5">
        {importable.map((c) => (
          <Row
            key={c.cwd}
            candidate={c}
            checked={selected.has(c.cwd)}
            onToggle={() => toggle(c.cwd)}
            description={descs[c.cwd]}
            onEnrich={() => enrich.mutate(c.cwd)}
            enriching={enrich.isPending && enrich.variables === c.cwd}
          />
        ))}
      </ul>

      {importable.length > 0 ? (
        <div className="mt-4 flex justify-end">
          <LabeledIconButton
            icon={<Download />}
            label={`Import selected (${selected.size})`}
            onClick={() => doImport.mutate()}
            disabled={selected.size === 0 || doImport.isPending}
          />
        </div>
      ) : null}
    </section>
  );
}

function Row({
  candidate,
  checked,
  onToggle,
  description,
  onEnrich,
  enriching,
}: {
  candidate: ImportCandidate;
  checked: boolean;
  onToggle: () => void;
  description: string | undefined;
  onEnrich: () => void;
  enriching: boolean;
}) {
  return (
    <li className={cn("rounded-md border border-border bg-card/50 px-3 py-2", checked && "border-primary/50")}>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={onToggle} className="size-4" />
        <span className="font-medium">{candidate.name}</span>
        {candidate.isGitRepo ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">git</span>
        ) : null}
        <span className="ml-auto">
          <LabeledIconButton
            icon={<Sparkles />}
            label={enriching ? "Asking…" : "Ask Claude"}
            variant="ghost"
            size="sm"
            onClick={onEnrich}
            disabled={enriching}
          />
        </span>
      </label>
      <div className="mt-0.5 truncate pl-6 text-xs text-muted-foreground">{candidate.cwd}</div>
      {candidate.gitRemote ? (
        <div className="truncate pl-6 text-[11px] text-muted-foreground">{candidate.gitRemote}</div>
      ) : null}
      {description ? <div className="mt-1 pl-6 text-xs text-foreground/80">{description}</div> : null}
    </li>
  );
}
