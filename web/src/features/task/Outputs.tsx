import type { TaskOutputFile } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileBarChart, FileText, Trash2 } from "lucide-react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { toast } from "../../components/Toaster";
import { deleteOutput, getOutputs, outputUrl } from "../../lib/api";
import { formatBytes } from "./Attachments";

/**
 * Files this task's agents PRODUCED (reports, PDFs, exports) — non-code
 * deliverables written to ~/.cadence/tasks/<id>/outputs/ instead of the repo.
 * Each file opens directly (served by the gateway), so the task is the one place
 * the deliverable lives. Renders nothing when the task produced no outputs —
 * a husk would imply every task should have them.
 */
export function OutputsSection({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const queryKey = ["task", taskId, "outputs"] as const;
  const outputs = useQuery({ queryKey, queryFn: () => getOutputs(taskId) });

  const remove = useMutation({
    mutationFn: (name: string) => deleteOutput(taskId, name),
    onSuccess: (_list, name) => {
      void qc.invalidateQueries({ queryKey });
      toast(`Removed ${name}.`);
    },
    onError: () => toast("Couldn’t remove the output file."),
  });

  if (!outputs.data?.length) return null;

  return (
    <section className="mt-5 rounded-lg border border-border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileBarChart className="size-4" aria-hidden />
        Outputs
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Files this task produced (reports, exports) — saved outside the repo; click to open.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {outputs.data.map((o: TaskOutputFile) => (
          <li
            key={o.name}
            className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-xs"
          >
            {o.mimeType.startsWith("image/") ? (
              <img
                src={outputUrl(taskId, o.name)}
                alt={o.name}
                className="size-8 shrink-0 rounded object-cover"
              />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <a
              href={outputUrl(taskId, o.name)}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate hover:underline"
              title={o.path}
            >
              {o.name}
            </a>
            <span className="shrink-0 text-muted-foreground">{formatBytes(o.size)}</span>
            <LabeledIconButton
              icon={<Trash2 />}
              label="Remove"
              variant="ghost"
              size="sm"
              onClick={() => remove.mutate(o.name)}
              disabled={remove.isPending}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
