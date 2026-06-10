import {
  computeNextRun,
  describeSchedule,
  type CreateRecurringInput,
  type Project,
  type RecurringCadence,
  type RecurringSchedule,
  type RecurringTask,
} from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CalendarClock,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { ChipSelect } from "../../components/ChipSelect";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { SelectBox } from "../../components/SelectBox";
import { Modal } from "../../components/Modal";
import { toast } from "../../components/Toaster";
import {
  createRecurring,
  deleteRecurring,
  getProjects,
  getRecurring,
  runRecurringNow,
  updateRecurring,
} from "../../lib/api";
import { formatAgo, formatDateTime, formatUntil, useDateFormats } from "../../lib/datetime";
import { cn } from "../../lib/utils";

/**
 * Recurring tasks (templates + schedule). Each card is one template; at its
 * trigger the background scheduler creates a REAL task that lands in the Inbox
 * and flows through triage like anything captured by hand. The view leads with
 * intention: every card says in plain words what will happen and when.
 */

// Monday-first picker order, mapped to the JS Date.getDay() convention (0 = Sunday).
const WEEKDAYS_UI: Array<{ dow: number; short: string; long: string }> = [
  { dow: 1, short: "Mon", long: "Monday" },
  { dow: 2, short: "Tue", long: "Tuesday" },
  { dow: 3, short: "Wed", long: "Wednesday" },
  { dow: 4, short: "Thu", long: "Thursday" },
  { dow: 5, short: "Fri", long: "Friday" },
  { dow: 6, short: "Sat", long: "Saturday" },
  { dow: 0, short: "Sun", long: "Sunday" },
];

const PRIORITY_OPTIONS = [
  { value: "P0", label: "Critical (P0)" },
  { value: "P1", label: "High (P1)" },
  { value: "P2", label: "Normal (P2)" },
  { value: "P3", label: "Low (P3)" },
];

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

export function RecurringView({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const qc = useQueryClient();
  const formats = useDateFormats();
  const recurring = useQuery({ queryKey: ["recurring"], queryFn: getRecurring });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringTask | null>(null);
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["recurring"] });

  const togglePause = useMutation({
    mutationFn: (r: RecurringTask) => updateRecurring(r.id, { paused: !r.paused }),
    onSuccess: (updated) => {
      invalidate();
      toast(updated.paused ? `“${updated.title}” paused — it won't run until resumed` : `“${updated.title}” resumed — next run ${formatDateTime(updated.nextRunAt, formats)}`);
    },
    onError: (e: Error) => toast(e.message),
  });

  const runNow = useMutation({
    mutationFn: (r: RecurringTask) => runRecurringNow(r.id),
    onSuccess: ({ task }) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      toast(`Task “${task.title}” created — it's in the Inbox now`);
    },
    onError: (e: Error) => toast(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteRecurring(id),
    onSuccess: () => {
      invalidate();
      setDeleteArmedId(null);
      toast("Recurring task deleted — tasks it already created are untouched");
    },
    onError: (e: Error) => toast(e.message),
  });

  const items = recurring.data ?? [];
  const projectById = new Map((projects.data ?? []).map((p) => [p.id, p]));

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="flex items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Repeat className="size-5" /> Recurring tasks
        </h1>
        <div className="ml-auto">
          <LabeledIconButton
            icon={<Plus />}
            label="New recurring task"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          />
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Templates that create a real task on a schedule — daily, weekly, or monthly. Each run lands
        in the Inbox and flows through triage like anything you capture yourself.
      </p>

      {recurring.isLoading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : recurring.isError ? (
        // No silent dead end: a failing endpoint says so and offers a retry,
        // instead of hiding behind a long "Loading…" or a fake empty state.
        <div className="mt-8 flex flex-col items-start gap-2 rounded-lg border border-red-400/40 bg-red-400/5 p-4">
          <p className="text-sm font-medium text-red-400">Couldn't load recurring tasks</p>
          <p className="text-sm text-muted-foreground">{(recurring.error as Error).message}</p>
          <LabeledIconButton
            icon={<Repeat />}
            label="Try again"
            size="sm"
            variant="secondary"
            onClick={() => void recurring.refetch()}
          />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <Repeat className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No recurring tasks yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Set one up for anything you do on a rhythm — a monthly timesheet, a weekly review, a
            daily check. Cadence creates the task for you, right on time.
          </p>
          <LabeledIconButton
            icon={<Plus />}
            label="Create your first one"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          />
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          {items.map((r) => {
            const project = r.projectId ? projectById.get(r.projectId) : undefined;
            const due = !r.paused && r.nextRunAt != null && r.nextRunAt <= Date.now();
            return (
              <section
                key={r.id}
                className={cn(
                  "rounded-lg border border-border bg-card p-4",
                  r.paused && "opacity-70",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">{r.title}</h2>
                  {r.paused ? (
                    <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                      Paused
                    </span>
                  ) : null}
                  <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    <Repeat className="size-3" />
                    {describeSchedule(r)}
                  </span>
                </div>

                {r.body ? (
                  <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{r.body}</p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarClock className="size-3.5" />
                    {r.paused ? (
                      "Paused — no next run"
                    ) : due ? (
                      <span className="text-amber-400">Due — runs within a moment</span>
                    ) : r.nextRunAt != null ? (
                      <>
                        Next run {formatDateTime(r.nextRunAt, formats)}
                        <span className="text-muted-foreground/70">
                          (in {formatUntil(r.nextRunAt)})
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                  {project ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: project.color ?? "#888" }}
                      />
                      {project.name}
                    </span>
                  ) : null}
                  {r.priority ? <span>Priority {r.priority}</span> : null}
                  {r.lastTriggeredAt != null && r.lastTaskId ? (
                    <button
                      type="button"
                      onClick={() => onOpenTask(r.lastTaskId as string)}
                      className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Last created {formatAgo(r.lastTriggeredAt)}
                      <ArrowUpRight className="size-3" />
                    </button>
                  ) : (
                    <span className="text-muted-foreground/70">Never run yet</span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <LabeledIconButton
                    icon={<Play />}
                    label="Run now"
                    size="sm"
                    variant="secondary"
                    title="Create the task immediately; the schedule continues from now"
                    onClick={() => runNow.mutate(r)}
                    disabled={runNow.isPending}
                  />
                  <LabeledIconButton
                    icon={r.paused ? <Play /> : <Pause />}
                    label={r.paused ? "Resume" : "Pause"}
                    size="sm"
                    variant="ghost"
                    onClick={() => togglePause.mutate(r)}
                    disabled={togglePause.isPending}
                  />
                  <LabeledIconButton
                    icon={<Pencil />}
                    label="Edit"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(r);
                      setEditorOpen(true);
                    }}
                  />
                  <div className="ml-auto">
                    {deleteArmedId === r.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Delete this template?</span>
                        <LabeledIconButton
                          icon={<Trash2 />}
                          label="Yes, delete"
                          size="sm"
                          variant="destructive"
                          onClick={() => remove.mutate(r.id)}
                          disabled={remove.isPending}
                        />
                        <LabeledIconButton
                          icon={<X />}
                          label="Keep it"
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteArmedId(null)}
                        />
                      </span>
                    ) : (
                      <LabeledIconButton
                        icon={<Trash2 />}
                        label="Delete"
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-red-400"
                        onClick={() => setDeleteArmedId(r.id)}
                      />
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {editorOpen ? (
        <RecurringEditor
          key={editing?.id ?? "new"}
          initial={editing}
          projects={projects.data ?? []}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Create/edit modal. The footer always answers the only question that matters:
 *  "when exactly will the next task appear?" — recomputed live as you pick. */
export function RecurringEditor({
  initial,
  projects,
  onClose,
}: {
  initial: RecurringTask | null;
  projects: Project[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const formats = useDateFormats();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [cadence, setCadence] = useState<RecurringCadence>(initial?.cadence ?? "weekly");
  const [dayOfWeek, setDayOfWeek] = useState<number>(initial?.dayOfWeek ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState<number>(initial?.dayOfMonth ?? 1);
  const [time, setTime] = useState(initial?.time ?? "09:00");
  const [projectSlug, setProjectSlug] = useState<string>(() => {
    const p = initial?.projectId ? projects.find((x) => x.id === initial.projectId) : undefined;
    return p?.slug ?? "none";
  });
  const [priority, setPriority] = useState<string>(initial?.priority ?? "none");

  const schedule: RecurringSchedule = {
    cadence,
    ...(cadence === "weekly" ? { dayOfWeek } : {}),
    ...(cadence === "monthly" ? { dayOfMonth } : {}),
    time,
  };
  const valid = Boolean((title.trim() || body.trim()) && /^\d{2}:\d{2}$/.test(time));
  const nextPreview = valid ? computeNextRun(schedule, Date.now()) : null;

  const save = useMutation({
    mutationFn: () => {
      const input: CreateRecurringInput = {
        ...(title.trim() ? { title: title.trim() } : {}),
        body: body.trim() || undefined,
        cadence,
        ...(cadence === "weekly" ? { dayOfWeek } : {}),
        ...(cadence === "monthly" ? { dayOfMonth } : {}),
        time,
        ...(projectSlug !== "none" ? { project: projectSlug } : {}),
        ...(priority !== "none" ? { priority } : {}),
      };
      return initial
        ? updateRecurring(initial.id, {
            ...input,
            title: title.trim() || initial.title,
            body,
            project: projectSlug === "none" ? null : projectSlug,
            priority: priority === "none" ? null : priority,
          })
        : createRecurring(input);
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["recurring"] });
      toast(
        initial
          ? `“${saved.title}” updated — next run ${formatDateTime(saved.nextRunAt, formats)}`
          : `“${saved.title}” scheduled — first run ${formatDateTime(saved.nextRunAt, formats)}`,
      );
      onClose();
    },
    onError: (e: Error) => toast(e.message),
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (valid && !save.isPending) save.mutate();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  };

  const segment = (value: RecurringCadence, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={cadence === value}
      onClick={() => setCadence(value)}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
        cadence === value
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <Modal
      title={initial ? "Edit recurring task" : "New recurring task"}
      subtitle="A template — Cadence creates a real task from it at every scheduled time."
      onClose={onClose}
    >
      <form onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">What should the task say?</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the modal exists to type this field
            autoFocus
            rows={4}
            placeholder="Describe the work like you'd capture any task — e.g. “Generate the monthly Toggl timesheet for the client and verify the totals.”"
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="text-xs text-muted-foreground">
            This becomes the task description on every run.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Title (optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Derived from the description when left empty"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-muted-foreground">Repeats</legend>
          <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
            {segment("daily", "Daily")}
            {segment("weekly", "Weekly")}
            {segment("monthly", "Monthly")}
          </div>

          {cadence === "weekly" ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Day of week">
              {WEEKDAYS_UI.map((d) => (
                <button
                  key={d.dow}
                  type="button"
                  title={d.long}
                  aria-pressed={dayOfWeek === d.dow}
                  onClick={() => setDayOfWeek(d.dow)}
                  className={cn(
                    "min-w-11 rounded-md border px-2 py-1.5 text-xs transition-colors",
                    dayOfWeek === d.dow
                      ? "border-primary/40 bg-primary/15 font-medium text-primary"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {d.short}
                </button>
              ))}
            </div>
          ) : null}

          {cadence === "monthly" ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-xs font-medium text-muted-foreground">On the</span>
                <SelectBox
                  label="Day of month"
                  size="sm"
                  className="w-24"
                  value={String(dayOfMonth)}
                  onChange={(v) => setDayOfMonth(Number(v))}
                  options={Array.from({ length: 31 }, (_, i) => i + 1).map((d) => ({
                    value: String(d),
                    label: ordinal(d),
                  }))}
                />
                <span className="text-xs font-medium text-muted-foreground">of every month</span>
              </div>
              {dayOfMonth >= 29 ? (
                <p className="text-xs text-muted-foreground">
                  Months with fewer days run on their last day instead — February included.
                </p>
              ) : null}
            </div>
          ) : null}

          <label className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">At</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Time of day"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <ChipSelect
            label="Project"
            value={projectSlug}
            active={projectSlug !== "none"}
            onChange={setProjectSlug}
            groups={[
              { options: [{ value: "none", label: "No project" }] },
              ...(projects.length
                ? [{ label: "Projects", options: projects.map((p) => ({ value: p.slug, label: p.name })) }]
                : []),
            ]}
          />
          <ChipSelect
            label="Priority"
            value={priority}
            active={priority !== "none"}
            onChange={setPriority}
            groups={[{ options: [{ value: "none", label: "None — let triage decide" }, ...PRIORITY_OPTIONS] }]}
          />
        </div>

        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
          <CalendarClock className="size-4 shrink-0 text-primary" />
          <p className="text-sm">
            <span className="font-medium text-primary">{describeSchedule(schedule)}.</span>{" "}
            <span className="text-muted-foreground">
              {nextPreview != null
                ? `${initial ? "Next" : "First"} task will be created ${formatDateTime(nextPreview, formats)}.`
                : "Add a description to schedule it."}
            </span>
          </p>
        </div>

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">⌘↵ to save</span>
          <LabeledIconButton icon={<X />} label="Cancel" variant="ghost" onClick={onClose} />
          <LabeledIconButton
            icon={initial ? <Pencil /> : <Repeat />}
            label={initial ? "Save changes" : "Create recurring task"}
            type="submit"
            disabled={!valid || save.isPending}
          />
        </div>
      </form>
    </Modal>
  );
}
