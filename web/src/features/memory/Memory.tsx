import type { MemoryFile } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Plus, Save, Sparkles } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getMemory, reflectMemory, saveMemoryFile } from "../../lib/api";

/**
 * Memory editor (spec §8.1): Cadence's self-written, hand-editable markdown
 * context — global cross-project memory + communication.md. Composed into every
 * agent run; the Reflector (5.2) will write here too.
 */
export function Memory() {
  const qc = useQueryClient();
  const memory = useQuery({ queryKey: ["memory"], queryFn: getMemory });
  const [newName, setNewName] = useState("");

  const create = useMutation({
    mutationFn: (name: string) => saveMemoryFile(name, `# ${name}\n\n`),
    onSuccess: () => {
      setNewName("");
      void qc.invalidateQueries({ queryKey: ["memory"] });
    },
  });

  const reflect = useMutation({
    mutationFn: reflectMemory,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    if (newName.trim() && !create.isPending) create.mutate(newName.trim());
  };

  const files = memory.data ?? [];

  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="flex items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BrainCircuit className="size-5" /> Memory
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {reflect.data ? (
            <span className="text-xs text-muted-foreground">
              {reflect.data.ran ? `Learned ${reflect.data.lessons ?? 0}` : "Nothing new to learn yet"}
            </span>
          ) : null}
          <LabeledIconButton
            icon={<Sparkles />}
            label="Reflect now"
            size="sm"
            variant="ghost"
            onClick={() => reflect.mutate()}
            disabled={reflect.isPending}
          />
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Cadence’s learned, hand-editable context — composed into every agent run. “Reflect now” distills
        lessons from your corrections.
      </p>

      <form onSubmit={onCreate} className="mt-5 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New memory file (e.g. communication, conventions)"
          aria-label="New memory file name"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <LabeledIconButton icon={<Plus />} label="Add file" type="submit" disabled={!newName.trim()} />
      </form>

      {files.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No memory yet. Add a file (e.g. <code>communication</code>) or let the Reflector learn over time.
        </p>
      ) : null}

      <div className="mt-6 flex flex-col gap-5">
        {files.map((f) => (
          <MemoryEditor key={f.name} file={f} />
        ))}
      </div>
    </div>
  );
}

function MemoryEditor({ file }: { file: MemoryFile }) {
  const qc = useQueryClient();
  const [content, setContent] = useState(file.content);
  const save = useMutation({
    mutationFn: () => saveMemoryFile(file.name, content),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });

  return (
    <section className="rounded-lg border border-border bg-card/40 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm font-medium">{file.name}.md</h2>
        <LabeledIconButton
          icon={save.isSuccess ? <Save /> : <Save />}
          label={save.isSuccess ? "Saved" : "Save"}
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending || content === file.content}
        />
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        aria-label={`${file.name} memory`}
        className="mt-2 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </section>
  );
}
