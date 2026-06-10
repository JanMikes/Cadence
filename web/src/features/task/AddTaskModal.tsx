import type { ReviewDirection, ReviewInspectResult } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, Plus, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { createTask, getProjects, inspectReviewUrl } from "../../lib/api";
import { isTauri } from "../../lib/tauri";

/** First PR/MR-looking URL in the text (cheap client check; the server parses properly). */
export function firstPrUrl(text: string): string | null {
  return text.match(/https?:\/\/\S+\/(?:pull|-\/merge_requests)\/\d+/)?.[0] ?? null;
}

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
 *  the global `c` shortcut. New tasks land in the Board's Inbox column to be refined later. */
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
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  // Review detection (§6.5.a, propose-don't-impose): a pasted PR/MR URL proposes a
  // code-review task with inferred direction + matched project — all editable chips.
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [direction, setDirection] = useState<ReviewDirection>("perform");
  const detectedUrl = firstPrUrl(`${body}\n${title}`);
  const inspect = useQuery({
    queryKey: ["review-inspect", detectedUrl],
    queryFn: () => inspectReviewUrl(detectedUrl as string),
    enabled: open && detectedUrl != null,
    staleTime: 60_000,
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects, enabled: open });
  const review: ReviewInspectResult | null = detectedUrl ? (inspect.data ?? null) : null;
  // Adopt the server's inferred direction whenever a new inspection lands.
  useEffect(() => {
    if (review?.ref) setDirection(review.direction);
  }, [review?.ref?.url, review?.direction]);

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
      setBody("");
      setTitle("");
      setReviewEnabled(true);
      setDirection("perform");
    }
  }, [open]);

  // Description-first capture: the title is optional — when left empty, the
  // refinement agent names the task automatically.
  const create = useMutation({
    mutationFn: () =>
      createTask({
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        ...(review?.ref && reviewEnabled
          ? {
              taskType: "code_review" as const,
              reviewDirection: direction,
              reviewRef: review.ref.url,
              ...(review.projectSlug ? { project: review.projectSlug } : {}),
            }
          : {}),
      }),
    onSuccess: (task) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      onOpenChange(false);
      onCreated?.(task.id);
    },
  });

  if (!open) return null;

  const canSubmit = Boolean(body.trim() || title.trim());

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSubmit && !create.isPending) create.mutate();
  };

  // ⌘/Ctrl+Enter submits from the description field (plain Enter inserts a newline).
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
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onBodyKey}
              autoFocus
              placeholder="Describe the task — what, where, why. Paste anything…"
              aria-label="Description"
              rows={4}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {review?.ref ? (
              <div className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <GitPullRequest className="size-3.5 shrink-0 text-primary" />
                  <span className="font-medium">
                    Looks like a code review — {review.ref.owner}/{review.ref.repo}
                    {review.ref.kind === "pr" ? " PR " : " MR "}#{review.ref.number}
                  </span>
                  <label className="ml-auto flex items-center gap-1 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={reviewEnabled}
                      onChange={(e) => setReviewEnabled(e.target.checked)}
                    />
                    Create as review
                  </label>
                </div>
                {reviewEnabled ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={direction}
                      onChange={(e) => setDirection(e.target.value as ReviewDirection)}
                      aria-label="Review direction"
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    >
                      <option value="perform">Review their PR/MR</option>
                      <option value="address">Address feedback on my PR/MR</option>
                    </select>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                      {review.projectSlug
                        ? `Project: ${
                            projects.data?.find((p) => p.slug === review.projectSlug)?.name ??
                            review.projectSlug
                          }`
                        : "No matching project"}
                    </span>
                    {review.author ? (
                      <span className="text-muted-foreground">
                        author @{review.author}
                        {review.account ? ` · you @${review.account}` : ""}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (optional — Cadence names it during refinement)"
              aria-label="Title (optional)"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">
              Lands on the Board (Inbox column) ·{" "}
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">⌘↵</kbd> to
              add ·{" "}
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">Esc</kbd> to
              cancel
            </span>
            <LabeledIconButton
              icon={<Plus />}
              label="Add task"
              type="submit"
              disabled={!canSubmit || create.isPending}
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
