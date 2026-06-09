import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { createTask } from "../../lib/api";
import { isTauri } from "../../lib/tauri";

/** True when focus is in a text field, so a bare-key shortcut shouldn't hijack it. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

/** The sidebar quick-action that opens the Add-task modal. Icon + text label (§10.1),
 *  with the keyboard hint shown on the right. */
export function AddTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Plus className="size-4" />
      <span>Add task</span>
      <kbd className="ml-auto rounded border border-primary-foreground/30 px-1 font-mono text-[10px] leading-4 text-primary-foreground/80">
        C
      </kbd>
    </button>
  );
}

/** Quick-add modal openable from anywhere — the sidebar button, the ⌘K palette, or
 *  the global `c` shortcut. New tasks land in the Inbox to be refined later. */
export function AddTaskModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional: called with the new task id after a successful create. */
  onCreated?: (taskId: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // Global shortcut: press "c" to open (when not typing in a field); Esc to close.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
        return;
      }
      if (open || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Start each open with a clean form.
  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () => createTask({ title: title.trim(), body: body.trim() || undefined }),
    onSuccess: (task) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      onOpenChange(false);
      onCreated?.(task.id);
    },
  });

  if (!open) return null;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (title.trim() && !create.isPending) create.mutate();
  };

  // ⌘/Ctrl+Enter submits from the notes field (plain Enter there inserts a newline).
  const onBodyKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (global handler); backdrop is a convenience
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit}>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight">Add task</h2>
              {isTauri() ? (
                <kbd
                  title="Global shortcut: opens quick-capture from any app"
                  className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  ⌘⇧Space anywhere
                </kbd>
              ) : null}
            </div>
            <LabeledIconButton
              icon={<X />}
              label="Close"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            />
          </div>

          <div className="flex flex-col gap-3 p-4">
            {/* biome-ignore lint/a11y/noAutofocus: the modal exists to be typed in immediately */}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="Task title…"
              aria-label="Task title"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onBodyKey}
              placeholder="Notes (optional)…"
              aria-label="Notes"
              rows={3}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">
              Lands in your Inbox ·{" "}
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">Esc</kbd> to
              cancel
            </span>
            <LabeledIconButton
              icon={<Plus />}
              label="Add task"
              type="submit"
              disabled={!title.trim() || create.isPending}
            />
          </div>
        </form>

        {create.isError ? (
          <p className="px-4 pb-3 text-xs text-red-400">
            Couldn’t add task — is the gateway running?
          </p>
        ) : null}
      </div>
    </div>
  );
}
