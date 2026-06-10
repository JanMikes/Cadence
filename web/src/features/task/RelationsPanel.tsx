import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork, Link2, Plus, X } from "lucide-react";
import { SelectBox } from "../../components/SelectBox";
import { addDep, getDeps, getSubtasks, getTasks, removeDep, updateTask } from "../../lib/api";
import { statusLabel } from "../../lib/status";

/**
 * Task relationships (spec §4): dependency graph (blockedBy / blocks) + subtasks
 * (parent / children). The lists ARE the navigable graph — click to open.
 */
export function RelationsPanel({
  taskId,
  parentTaskId,
  onOpen,
}: {
  taskId: string;
  parentTaskId: string | null;
  onOpen: (id: string) => void;
}) {
  const qc = useQueryClient();
  const deps = useQuery({ queryKey: ["task", taskId, "deps"], queryFn: () => getDeps(taskId) });
  const subtasks = useQuery({ queryKey: ["task", taskId, "subtasks"], queryFn: () => getSubtasks(taskId) });
  const tasks = useQuery({ queryKey: ["tasks", "all"], queryFn: () => getTasks() });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["task", taskId] });
    void qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const add = useMutation({ mutationFn: (blockerId: string) => addDep(taskId, blockerId), onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: (blockerId: string) => removeDep(taskId, blockerId),
    onSuccess: invalidate,
  });
  const setParent = useMutation({
    mutationFn: (parent: string | null) => updateTask(taskId, { parentTask: parent }),
    onSuccess: invalidate,
  });

  const others = (tasks.data ?? []).filter((t) => t.id !== taskId);
  const blockedBy = deps.data?.blockedBy ?? [];
  const blocks = deps.data?.blocks ?? [];
  const children = subtasks.data ?? [];

  const link = (id: string, title: string, suffix?: string) => (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className="flex w-full items-center justify-between gap-2 rounded border border-border bg-card/50 px-2 py-1 text-left text-xs hover:border-primary/50"
    >
      <span className="truncate">{title}</span>
      {suffix ? <span className="shrink-0 text-muted-foreground">{suffix}</span> : null}
    </button>
  );

  return (
    <section className="mt-7 border-t border-border pt-5">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Link2 className="size-4" /> Relationships
      </h3>

      <div className="mt-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Blocked by</span>
          <SelectBox
            label="Add blocker"
            size="sm"
            className="w-44"
            placeholder="+ add blocker…"
            value=""
            onChange={(v) => v && add.mutate(v)}
            options={others.map((t) => ({ value: t.id, label: t.title }))}
          />
        </div>
        {blockedBy.length === 0 ? (
          <span className="text-xs text-muted-foreground">— none —</span>
        ) : (
          blockedBy.map((t) => (
            <div key={t.id} className="flex items-center gap-1.5">
              <span className="w-4 text-center text-[11px]">{t.status === "done" ? "✅" : "⏳"}</span>
              {link(t.id, t.title, statusLabel(t.status))}
              <button
                type="button"
                aria-label={`Remove blocker ${t.title}`}
                onClick={() => remove.mutate(t.id)}
                className="rounded p-1 text-muted-foreground hover:text-red-400"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      {blocks.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Blocks</span>
          {blocks.map((t) => (
            <div key={t.id}>{link(t.id, t.title, statusLabel(t.status))}</div>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <GitFork className="size-3.5" /> Parent
        </span>
        <SelectBox
          label="Parent task"
          size="sm"
          className="max-w-[14rem]"
          value={parentTaskId ?? ""}
          onChange={(v) => setParent.mutate(v || null)}
          options={[
            { value: "", label: "— none —" },
            ...others.map((t) => ({ value: t.id, label: t.title })),
          ]}
        />
      </div>

      {children.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Plus className="size-3.5" /> Subtasks ({children.length})
          </span>
          {children.map((t) => (
            <div key={t.id}>{link(t.id, t.title, statusLabel(t.status))}</div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
