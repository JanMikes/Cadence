import {
  DELIVERY_MODES,
  PERMISSION_MODES,
  type Project,
  type UpdateProjectInput,
  type WorktreeCheck,
} from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FolderGit2, Plus, Save, Sparkles, TriangleAlert, X } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { checkWorktreeReadiness, createProject, getProjects, updateProject } from "../../lib/api";
import { formatDateTime, useDateFormats } from "../../lib/datetime";
import { useServerMessages } from "../../lib/ws";
import { ImportProjects } from "./ImportProjects";

const PERMISSION_LABELS: Record<string, string> = {
  auto: "Auto",
  manual: "Manual (approve in app)",
  dangerous: "Dangerous (skip checks)",
};
const DELIVERY_LABELS: Record<string, string> = {
  branch_summary: "Branch + summary",
  auto_pr: "Auto PR",
  apply_in_place: "Apply in place",
};

interface FormValues {
  name: string;
  rootPath: string;
  color: string;
  defaultPermissionMode: string;
  defaultDeliveryMode: string;
  autonomy: string; // "inherit" | "on" | "off"
  worktreesEnabled: boolean;
  systemPrompt: string;
}

const EMPTY: FormValues = {
  name: "",
  rootPath: "",
  color: "",
  defaultPermissionMode: "auto",
  defaultDeliveryMode: "branch_summary",
  autonomy: "inherit",
  worktreesEnabled: false,
  systemPrompt: "",
};

/** Map the tri-state autonomy select ⇄ the boolean|null field (null = inherit). */
const autonomyToField = (b: boolean | null): string => (b == null ? "inherit" : b ? "on" : "off");
const fieldToAutonomy = (s: string): boolean | null => (s === "inherit" ? null : s === "on");

export function Projects() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const [editing, setEditing] = useState<Project | null>(null);

  const create = useMutation({
    mutationFn: (v: FormValues) =>
      createProject({
        name: v.name.trim(),
        rootPath: v.rootPath.trim() || undefined,
        color: v.color.trim() || undefined,
        defaultPermissionMode: v.defaultPermissionMode,
        defaultDeliveryMode: v.defaultDeliveryMode,
        autonomy: fieldToAutonomy(v.autonomy),
        worktreesEnabled: v.worktreesEnabled,
        systemPrompt: v.systemPrompt.trim() || undefined,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        A project is usually a git repo + working directory. Tasks assigned to it run in its rootPath.
      </p>

      <section className="mt-6 rounded-lg border border-border bg-card/40 p-4">
        <h2 className="text-sm font-medium">New project</h2>
        <ProjectFields
          key={create.isSuccess ? "reset" : "form"}
          initial={EMPTY}
          submitLabel="Create project"
          submitIcon={<Plus />}
          pending={create.isPending}
          onSubmit={(v) => create.mutate(v)}
        />
        {create.isError ? (
          <p className="mt-2 text-xs text-red-400">Couldn’t create — is the gateway running?</p>
        ) : null}
      </section>

      <ImportProjects />

      <ul className="mt-6 flex flex-col gap-2">
        {projects.isLoading ? <li className="text-sm text-muted-foreground">Loading…</li> : null}
        {projects.data?.length === 0 ? (
          <li className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No projects yet — create your first above.
          </li>
        ) : null}
        {projects.data?.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setEditing(p)}
              className="flex w-full items-center gap-3 rounded-md border border-border bg-card/50 px-4 py-3 text-left transition-colors hover:border-primary/50"
            >
              <span
                className="size-3 shrink-0 rounded-full border border-border"
                style={p.color ? { backgroundColor: p.color } : undefined}
              />
              <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.rootPath ?? "no rootPath"} · {PERMISSION_LABELS[p.defaultPermissionMode]}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {editing ? (
        <EditDrawer project={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

function EditDrawer({ project, onClose }: { project: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: UpdateProjectInput) => updateProject(project.slug, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-[440px] max-w-full flex-col overflow-auto border-l border-border bg-background p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">{project.name}</h2>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{project.slug}</p>

        <ProjectFields
          initial={{
            name: project.name,
            rootPath: project.rootPath ?? "",
            color: project.color ?? "",
            defaultPermissionMode: project.defaultPermissionMode,
            defaultDeliveryMode: project.defaultDeliveryMode,
            autonomy: autonomyToField(project.autonomy),
            worktreesEnabled: project.worktreesEnabled,
            systemPrompt: project.systemPrompt ?? "",
          }}
          submitLabel="Save changes"
          submitIcon={<Save />}
          pending={save.isPending}
          onSubmit={(v) =>
            save.mutate({
              name: v.name.trim(),
              rootPath: v.rootPath.trim() || null,
              color: v.color.trim() || null,
              defaultPermissionMode: v.defaultPermissionMode,
              defaultDeliveryMode: v.defaultDeliveryMode,
              autonomy: fieldToAutonomy(v.autonomy),
              worktreesEnabled: v.worktreesEnabled,
              systemPrompt: v.systemPrompt.trim() || null,
            })
          }
        />
        {save.isError ? <p className="mt-2 text-xs text-red-400">Couldn’t save changes.</p> : null}

        <WorktreeReadiness project={project} />
      </aside>
    </div>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  high: "bg-red-500/15 text-red-400",
  medium: "bg-amber-500/15 text-amber-400",
  low: "bg-muted text-muted-foreground",
};

/**
 * "Ask Claude to check" panel (§9, propose-don't-impose): a read-only run inspects the
 * repo for worktree blockers; the persisted verdict informs the Git worktrees toggle —
 * the human flips it. Live data comes from the shared ["projects"] query (the WS
 * project:updated invalidation refreshes it when the check lands).
 */
function WorktreeReadiness({ project }: { project: Project }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const live = projects.data?.find((p) => p.slug === project.slug) ?? project;
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useMutation({
    mutationFn: () => checkWorktreeReadiness(project.slug),
    onMutate: () => {
      setChecking(true);
      setError(null);
    },
    onError: () => {
      setChecking(false);
      setError("Couldn’t start the check — is the gateway running?");
    },
  });

  // The check is fire-and-forget on the server; its outcome arrives over WS.
  useServerMessages((msg) => {
    if (msg.type !== "event") return;
    if (msg.name === "project:updated" && msg.payload === project.slug) setChecking(false);
    if (msg.name === "project:worktree-check-failed") {
      const p = msg.payload as { slug?: string; reason?: string };
      if (p?.slug === project.slug) {
        setChecking(false);
        setError(p.reason ?? "Check failed.");
      }
    }
  });

  const result = live.worktreeCheck;
  return (
    <section className="mt-6 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Worktree readiness</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Not every repo runs from a fresh second checkout (.env files, docker ports, install
            steps). Let Claude inspect this repo before enabling worktrees.
          </p>
        </div>
        <LabeledIconButton
          icon={<Sparkles />}
          label={checking ? "Checking…" : "Ask Claude to check"}
          variant="ghost"
          size="sm"
          onClick={() => check.mutate()}
          disabled={checking || !live.rootPath}
        />
      </div>
      {!live.rootPath ? (
        <p className="mt-2 text-xs text-muted-foreground">Set a rootPath first.</p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      {result ? <WorktreeCheckCard check={result} /> : null}
    </section>
  );
}

function WorktreeCheckCard({ check }: { check: WorktreeCheck }) {
  const fmts = useDateFormats();
  const ready = check.verdict === "ready";
  return (
    <div className="mt-3 rounded-md border border-border bg-background/60 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        {ready ? (
          <>
            <CheckCircle2 className="size-4 text-emerald-400" />
            <span className="text-emerald-400">Ready for worktrees</span>
          </>
        ) : (
          <>
            <TriangleAlert className="size-4 text-amber-400" />
            <span className="text-amber-400">
              {check.blockers.length} blocker{check.blockers.length === 1 ? "" : "s"} found
            </span>
          </>
        )}
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          {formatDateTime(check.checkedAt, fmts)}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-foreground/80">{check.summary}</p>
      {check.blockers.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {check.blockers.map((b) => (
            <li key={b.title} className="text-xs">
              <span
                className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] ${SEVERITY_STYLES[b.severity] ?? SEVERITY_STYLES.low}`}
              >
                {b.severity}
              </span>
              <span className="font-medium">{b.title}</span>
              {b.detail ? <span className="text-muted-foreground"> — {b.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {check.recommendation ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Recommendation:</span> {check.recommendation}
        </p>
      ) : null}
    </div>
  );
}

function ProjectFields({
  initial,
  submitLabel,
  submitIcon,
  pending,
  onSubmit,
}: {
  initial: FormValues;
  submitLabel: string;
  submitIcon: ReactNode;
  pending: boolean;
  onSubmit: (v: FormValues) => void;
}) {
  const [v, setV] = useState<FormValues>(initial);
  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) => setV((p) => ({ ...p, [k]: val }));

  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (v.name.trim() && !pending) onSubmit(v);
  };

  const field = "rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <form onSubmit={onFormSubmit} className="mt-3 flex flex-col gap-3">
      <input
        value={v.name}
        onChange={(e) => set("name", e.target.value)}
        placeholder="Project name"
        aria-label="Project name"
        className={field}
      />
      <input
        value={v.rootPath}
        onChange={(e) => set("rootPath", e.target.value)}
        placeholder="rootPath (e.g. /Users/me/code/acme)"
        aria-label="rootPath"
        className={field}
      />
      <div className="flex gap-3">
        <input
          value={v.color}
          onChange={(e) => set("color", e.target.value)}
          placeholder="Color (#6ea8fe)"
          aria-label="Color"
          className={`${field} flex-1`}
        />
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Default permission mode
        <select
          value={v.defaultPermissionMode}
          onChange={(e) => set("defaultPermissionMode", e.target.value)}
          className={field}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {PERMISSION_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Default delivery mode
        <select
          value={v.defaultDeliveryMode}
          onChange={(e) => set("defaultDeliveryMode", e.target.value)}
          className={field}
        >
          {DELIVERY_MODES.map((m) => (
            <option key={m} value={m}>
              {DELIVERY_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Autonomy (auto-triage &amp; refine tasks)
        <select value={v.autonomy} onChange={(e) => set("autonomy", e.target.value)} className={field}>
          <option value="inherit">Inherit global</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-card px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-foreground">Git worktrees</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Run implementations in an isolated worktree + branch next to the repo (parallel-safe,
            full tool access). Needs a repo that works from a fresh checkout. When off,
            implementations run one at a time in the project directory on a task branch.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={v.worktreesEnabled}
          aria-label="Git worktrees"
          onClick={() => set("worktreesEnabled", !v.worktreesEnabled)}
          className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            v.worktreesEnabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block size-5 rounded-full bg-white transition-transform ${
              v.worktreesEnabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      <textarea
        value={v.systemPrompt}
        onChange={(e) => set("systemPrompt", e.target.value)}
        placeholder="System prompt — project context layer composed into every agent run"
        rows={3}
        aria-label="System prompt"
        className={field}
      />
      <div className="flex justify-end">
        <LabeledIconButton
          icon={submitIcon}
          label={submitLabel}
          type="submit"
          disabled={!v.name.trim() || pending}
        />
      </div>
    </form>
  );
}
