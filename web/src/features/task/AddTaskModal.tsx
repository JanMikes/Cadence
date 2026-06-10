import type { PermissionMode, ReviewDirection, ReviewInspectResult } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, Paperclip, Plus, X } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChipSelect } from "../../components/ChipSelect";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { SelectBox } from "../../components/SelectBox";
import { toast } from "../../components/Toaster";
import { createTask, getFleets, getProjects, getTasks, inspectReviewUrl, uploadAttachments } from "../../lib/api";
import { isTauri } from "../../lib/tauri";
import { eventFiles, formatBytes } from "./Attachments";

/** First PR/MR-looking URL in the text (cheap client check; the server parses properly). */
export function firstPrUrl(text: string): string | null {
  return text.match(/https?:\/\/\S+\/(?:pull|-\/merge_requests)\/\d+/)?.[0] ?? null;
}

type DeadlineChip = "auto" | "none" | "today" | "tomorrow" | "week" | "date";

/** Resolve a deadline chip to epoch ms (local end-of-day — a deadline means "by the
 *  end of that day", and parsing yyyy-mm-dd via Date.parse would drift to UTC). */
export function deadlineChipMs(chip: DeadlineChip, dateStr: string, now = new Date()): number | null {
  const endOfDay = (d: Date) => {
    d.setHours(23, 59, 59, 0);
    return d.getTime();
  };
  if (chip === "today") return endOfDay(new Date(now));
  if (chip === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return endOfDay(d);
  }
  if (chip === "week") {
    // End of the current week = the upcoming Sunday (today, if it is Sunday).
    const d = new Date(now);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    return endOfDay(d);
  }
  if (chip === "date") {
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return endOfDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  return null;
}

const PRIORITY_LABELS: Array<{ value: string; label: string }> = [
  { value: "P0", label: "Critical (P0)" },
  { value: "P1", label: "High (P1)" },
  { value: "P2", label: "Normal (P2)" },
  { value: "P3", label: "Low (P3)" },
];

/** Option label for a task in the Parent / Blocked-by pickers. */
function taskOptionLabel(t: { title: string }): string {
  return t.title.length > 48 ? `${t.title.slice(0, 48)}…` : t.title;
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
  // Capture chips (composer-style): everything on Auto/default is left to the triage
  // agent; an explicit pick is sent with the capture and pinned — triage never
  // overrides it. Project "auto" + an unconfident triage ⇒ a "which project?" card.
  const [projectChip, setProjectChip] = useState<string>("auto"); // auto | none | <slug>
  const [deadlineChip, setDeadlineChip] = useState<DeadlineChip>("auto");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [priorityChip, setPriorityChip] = useState<string>("auto"); // auto | P0..P3
  const [permChip, setPermChip] = useState<string>("inherit"); // inherit | auto | manual | dangerous
  const [fleetChip, setFleetChip] = useState<string>("none"); // none | <slug>
  const [parentChip, setParentChip] = useState<string>("none"); // none | <taskId>
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  // Files attached at capture (drop/paste/pick) — uploaded right after the task is
  // created, so they're already agent context when triage/refinement runs.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
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
  const fleets = useQuery({ queryKey: ["fleets"], queryFn: getFleets, enabled: open });
  const tasks = useQuery({ queryKey: ["tasks", "all"], queryFn: () => getTasks(), enabled: open });
  const review: ReviewInspectResult | null = detectedUrl ? (inspect.data ?? null) : null;
  // Adopt the server's inferred direction + matched project whenever a new inspection
  // lands — into the visible chips, so the proposal stays one click from corrected.
  useEffect(() => {
    if (review?.ref) {
      setDirection(review.direction);
      if (review.projectSlug) {
        setProjectChip((cur) => (cur === "auto" ? (review.projectSlug as string) : cur));
      }
    }
  }, [review?.ref?.url, review?.direction, review?.projectSlug]);

  // "Recent" project section: you usually work in batches, so the projects of the
  // newest tasks come first (capped; the rest are one typeahead away).
  const recentSlugs: string[] = [];
  if (projects.data && tasks.data) {
    for (const t of tasks.data.slice(0, 15)) {
      const slug = projects.data.find((p) => p.id === t.projectId)?.slug;
      if (slug && !recentSlugs.includes(slug)) recentSlugs.push(slug);
      if (recentSlugs.length >= 5) break;
    }
  }
  const projectGroups = [
    {
      options: [
        { value: "auto", label: "✨ Auto (triage decides)" },
        { value: "none", label: "— None" },
      ],
    },
    ...(recentSlugs.length
      ? [
          {
            label: "Recent",
            options: recentSlugs.map((slug) => ({
              value: slug,
              label: projects.data?.find((p) => p.slug === slug)?.name ?? slug,
            })),
          },
        ]
      : []),
    {
      label: recentSlugs.length ? "All projects" : "Projects",
      options: (projects.data ?? [])
        .filter((p) => !recentSlugs.includes(p.slug))
        .map((p) => ({ value: p.slug, label: p.name })),
    },
  ];

  // Parent / Blocked-by candidates: newest open tasks (native typeahead covers search).
  const openTasks = (tasks.data ?? [])
    .filter((t) => t.status !== "done" && t.status !== "cancelled")
    .slice(0, 30);

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
      setProjectChip("auto");
      setDeadlineChip("auto");
      setDeadlineDate("");
      setPriorityChip("auto");
      setPermChip("inherit");
      setFleetChip("none");
      setParentChip("none");
      setBlockedBy([]);
      setReviewEnabled(true);
      setDirection("perform");
      setPendingFiles([]);
    }
  }, [open]);

  // An unfilled date pick is still Auto, not an accidental "no deadline".
  const effectiveDeadline = deadlineChip === "date" && !deadlineDate ? "auto" : deadlineChip;

  // Description-first capture: the title is optional — when left empty, the
  // refinement agent names the task automatically. Chip keys are sent only when
  // off-Auto: key presence pins the field server-side.
  const create = useMutation({
    mutationFn: async () => {
      const task = await createTask({
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        ...(review?.ref && reviewEnabled
          ? {
              taskType: "code_review" as const,
              reviewDirection: direction,
              reviewRef: review.ref.url,
            }
          : {}),
        ...(projectChip !== "auto" ? { project: projectChip === "none" ? null : projectChip } : {}),
        ...(effectiveDeadline !== "auto"
          ? { deadline: deadlineChipMs(effectiveDeadline, deadlineDate) }
          : {}),
        ...(priorityChip !== "auto" ? { priority: priorityChip } : {}),
        ...(permChip !== "inherit" ? { permissionMode: permChip as PermissionMode } : {}),
        ...(fleetChip !== "none" ? { fleet: fleetChip } : {}),
        ...(parentChip !== "none" ? { parentTask: parentChip } : {}),
        ...(blockedBy.length ? { blockedBy } : {}),
      });
      if (pendingFiles.length) {
        // The task exists either way — a failed upload shouldn't lose the capture.
        try {
          await uploadAttachments(task.id, pendingFiles);
        } catch {
          toast("Task added, but the attachments didn’t upload — re-add them from the task.");
        }
      }
      return task;
    },
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

  // Terminal parity: paste a screenshot or drop files onto the description and they
  // ride along as task attachments (context for the agents).
  const addFiles = (files: File[]) => {
    if (files.length) setPendingFiles((cur) => [...cur, ...files]);
  };
  const onBodyPaste = (e: ClipboardEvent) => {
    const files = eventFiles(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onBodyDrop = (e: DragEvent) => {
    const files = eventFiles(e.dataTransfer);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (global handler); backdrop is a convenience
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-card shadow-xl"
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
            <div className="flex flex-wrap items-center gap-1.5">
              <ChipSelect
                label="Project"
                value={projectChip}
                display={projectChip === "auto" ? "✨ Auto" : undefined}
                groups={projectGroups}
                onChange={setProjectChip}
                active={projectChip !== "auto"}
                title="Where this task belongs. Auto: triage routes it (and asks you when unsure)."
              />
              <ChipSelect
                label="Deadline"
                value={deadlineChip}
                display={
                  deadlineChip === "date" && deadlineDate ? deadlineDate : undefined
                }
                groups={[
                  {
                    options: [
                      { value: "auto", label: "✨ Auto (detect from text)" },
                      { value: "none", label: "— None" },
                      { value: "today", label: "Today" },
                      { value: "tomorrow", label: "Tomorrow" },
                      { value: "week", label: "This week" },
                      { value: "date", label: "Pick a date…" },
                    ],
                  },
                ]}
                onChange={(v) => setDeadlineChip(v as DeadlineChip)}
                active={effectiveDeadline !== "auto"}
              />
              {deadlineChip === "date" ? (
                <input
                  type="date"
                  value={deadlineDate}
                  onChange={(e) => setDeadlineDate(e.target.value)}
                  aria-label="Deadline date"
                  // biome-ignore lint/a11y/noAutofocus: just revealed by picking "Pick a date…"
                  autoFocus
                  className="rounded-md border border-border bg-background px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : null}
              <ChipSelect
                label="Priority"
                value={priorityChip}
                groups={[{ options: [{ value: "auto", label: "✨ Auto" }, ...PRIORITY_LABELS] }]}
                onChange={setPriorityChip}
                active={priorityChip !== "auto"}
              />
              <ChipSelect
                label="Permissions"
                value={permChip}
                groups={[
                  {
                    options: [
                      { value: "inherit", label: "Inherit (project default)" },
                      { value: "auto", label: "Auto-accept" },
                      { value: "manual", label: "Manual approval" },
                      { value: "dangerous", label: "Dangerous (skip all)" },
                    ],
                  },
                ]}
                onChange={setPermChip}
                active={permChip !== "inherit"}
              />
              {fleets.data?.length ? (
                <ChipSelect
                  label="Fleet"
                  value={fleetChip}
                  groups={[
                    {
                      options: [
                        { value: "none", label: "— None" },
                        ...fleets.data.map((f) => ({ value: f.slug, label: f.name })),
                      ],
                    },
                  ]}
                  onChange={setFleetChip}
                  active={fleetChip !== "none"}
                />
              ) : null}
              {openTasks.length ? (
                <>
                  <ChipSelect
                    label="Parent"
                    value={parentChip}
                    groups={[
                      {
                        options: [
                          { value: "none", label: "— None" },
                          ...openTasks.map((t) => ({ value: t.id, label: taskOptionLabel(t) })),
                        ],
                      },
                    ]}
                    onChange={setParentChip}
                    active={parentChip !== "none"}
                    title="Make this a subtask of an existing task."
                  />
                  <ChipSelect
                    label="Blocked by"
                    value=""
                    display={blockedBy.length ? `${blockedBy.length} task${blockedBy.length > 1 ? "s" : ""}` : "— None"}
                    groups={[
                      {
                        options: [
                          { value: "", label: blockedBy.length ? "Add another…" : "— None" },
                          ...openTasks
                            .filter((t) => !blockedBy.includes(t.id))
                            .map((t) => ({ value: t.id, label: taskOptionLabel(t) })),
                        ],
                      },
                    ]}
                    onChange={(id) => {
                      if (id) setBlockedBy((cur) => [...cur, id]);
                    }}
                    active={blockedBy.length > 0}
                    title="Tasks that must finish before this one can start."
                  />
                </>
              ) : null}
            </div>
            {blockedBy.length ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Blocked by:</span>
                {blockedBy.map((id) => {
                  const t = openTasks.find((x) => x.id === id) ?? tasks.data?.find((x) => x.id === id);
                  const label = t ? taskOptionLabel(t) : id;
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
                    >
                      {label}
                      <button
                        type="button"
                        aria-label={`Remove blocker ${label}`}
                        onClick={() => setBlockedBy((cur) => cur.filter((x) => x !== id))}
                        className="rounded-full text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : null}
            {/* biome-ignore lint/a11y/noAutofocus: the modal exists to be typed in immediately */}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onBodyKey}
              onPaste={onBodyPaste}
              onDrop={onBodyDrop}
              onDragOver={(e) => e.preventDefault()}
              autoFocus
              placeholder="Describe the task — what, where, why. Paste anything (files & screenshots too)…"
              aria-label="Description"
              rows={4}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <LabeledIconButton
                icon={<Paperclip />}
                label="Attach files"
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
                title="Attached files are passed to Claude as context (images included)."
              />
              <input
                ref={fileInput}
                type="file"
                multiple
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
                className="hidden"
                aria-label="Attach files"
              />
              {pendingFiles.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  <Paperclip className="size-3 text-muted-foreground" aria-hidden />
                  {f.name} · {formatBytes(f.size)}
                  <button
                    type="button"
                    aria-label={`Remove attachment ${f.name}`}
                    onClick={() => setPendingFiles((cur) => cur.filter((_, j) => j !== i))}
                    className="rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
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
                    <SelectBox
                      label="Review direction"
                      size="sm"
                      className="w-60"
                      value={direction}
                      onChange={(v) => setDirection(v as ReviewDirection)}
                      options={[
                        { value: "perform", label: "Review their PR/MR" },
                        { value: "address", label: "Address feedback on my PR/MR" },
                      ]}
                    />
                    {!review.projectSlug ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                        No matching project
                      </span>
                    ) : null}
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
              Chips on Auto are decided during refinement ·{" "}
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
