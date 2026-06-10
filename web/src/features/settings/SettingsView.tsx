import type { AgentPromptInfo } from "@cadence/shared";
import { DELIVERY_MODE_INFO, DELIVERY_MODES, PERMISSION_MODES, TERMINAL_APPS } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CalendarClock, Check, Gauge, GitPullRequest, Save, Settings2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { SelectBox } from "../../components/SelectBox";
import { getAgentPrompts, getSettings, updateSettings } from "../../lib/api";
import { DEFAULT_FORMATS, formatTimestamp, SYSTEM_FORMAT } from "../../lib/datetime";
import { getAutostart, isTauri, setAutostart } from "../../lib/tauri";
import { cn } from "../../lib/utils";

const FIELD =
  "rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

type SectionId = "general" | "agents" | "formats" | "operations" | "review";

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Settings2 }> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "agents", label: "Agents & Prompts", icon: Bot },
  { id: "formats", label: "Formats", icon: CalendarClock },
  { id: "operations", label: "Operations", icon: Gauge },
  { id: "review", label: "Code review", icon: GitPullRequest },
];

export function SettingsView() {
  const [section, setSection] = useState<SectionId>("general");
  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Global defaults (overridable per project/task), agent prompts, and the preferred terminal.
      </p>

      <div className="mt-6 flex items-start gap-6">
        <nav aria-label="Settings sections" className="flex w-44 shrink-0 flex-col gap-1">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                section === id
                  ? "bg-primary/10 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-card hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {section === "general" ? <GeneralSection /> : null}
          {section === "agents" ? <AgentsPromptsSection /> : null}
          {section === "formats" ? <FormatsSection /> : null}
          {section === "operations" ? <OperationsSection /> : null}
          {section === "review" ? <ReviewSection /> : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- General

function GeneralSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });

  const [terminal, setTerminal] = useState("Terminal");
  const [perm, setPerm] = useState("auto");
  const [delivery, setDelivery] = useState("branch_summary");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [autonomy, setAutonomy] = useState(false);
  const [claudeBin, setClaudeBin] = useState("");
  const inTauri = isTauri();
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setTerminal(s.preferredTerminal);
    setPerm(s.global.defaultPermissionMode);
    setDelivery(s.global.defaultDeliveryMode);
    setModel(s.global.defaultModel ?? "");
    setPrompt(s.global.systemPrompt);
    setAutonomy(s.global.autonomy ?? false);
    setClaudeBin(s.claudeBinPath ?? "");
  }, [settings.data]);

  // "Launch at login" is a native (autostart) toggle, not a settings.json field — load + set it via
  // the Tauri bridge. Only present inside Cadence.app.
  useEffect(() => {
    if (!inTauri) return;
    void getAutostart().then((v) => {
      if (v !== null) setLaunchAtLogin(v);
    });
  }, [inTauri]);

  const toggleLaunchAtLogin = async () => {
    const next = !launchAtLogin;
    if (await setAutostart(next)) setLaunchAtLogin(next);
  };

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        preferredTerminal: terminal,
        claudeBinPath: claudeBin.trim() || undefined,
        global: {
          defaultPermissionMode: perm,
          defaultDeliveryMode: delivery,
          defaultModel: model.trim() || null,
          systemPrompt: prompt,
          autonomy,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Toggle
        label="Autonomy"
        help="When on, Cadence triages and refines every captured task automatically (spawns Claude in the background). Off by default; override per project."
        checked={autonomy}
        onToggle={() => setAutonomy((v) => !v)}
      />

      {inTauri ? (
        <Toggle
          label="Launch at login"
          help="Start Cadence automatically when you log in (to the menubar). Desktop app only."
          checked={launchAtLogin}
          onToggle={() => void toggleLaunchAtLogin()}
        />
      ) : null}

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        Preferred terminal (for one-click handoff)
        <SelectBox
          label="Preferred terminal"
          value={terminal}
          onChange={setTerminal}
          options={TERMINAL_APPS.map((t) => ({ value: t, label: t }))}
        />
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        Default permission mode
        <SelectBox
          label="Default permission mode"
          value={perm}
          onChange={setPerm}
          options={PERMISSION_MODES.map((m) => ({ value: m, label: m }))}
        />
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        Default delivery mode
        <SelectBox
          label="Default delivery mode"
          value={delivery}
          onChange={setDelivery}
          options={DELIVERY_MODES.map((m) => ({
            value: m,
            label: DELIVERY_MODE_INFO[m].label,
            hint: DELIVERY_MODE_INFO[m].description,
          }))}
        />
        <span className="text-[11px] leading-snug text-muted-foreground/80">
          {DELIVERY_MODE_INFO[delivery as keyof typeof DELIVERY_MODE_INFO]?.description}
        </span>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Default model (blank = claude default)
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="claude-opus-4-8"
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Claude binary path (blank = found on PATH)
        <input
          value={claudeBin}
          onChange={(e) => setClaudeBin(e.target.value)}
          placeholder="/Users/you/.local/bin/claude"
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Global system prompt (composed into every agent run)
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="e.g. Always prefer small, reviewable diffs."
          className={FIELD}
        />
        <span className="text-[11px] leading-relaxed">
          This is a <strong>context layer</strong> added to every run (global → project → task). The
          per-agent <em>instructions</em> — what Triage, Discovery, the Implementer… are told to do —
          live in <strong>Agents &amp; Prompts</strong>.
        </span>
      </label>

      <div className="flex items-center justify-end gap-3">
        {save.isSuccess ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-500">
            <Check className="size-3.5" /> Saved
          </span>
        ) : null}
        <LabeledIconButton icon={<Save />} label="Save settings" type="submit" disabled={save.isPending} />
      </div>
    </form>
  );
}

function Toggle({
  label,
  help,
  checked,
  onToggle,
}: {
  label: string;
  help: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card/40 p-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`inline-block size-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Formats (6.3.d)

const FORMAT_PRESETS: Array<{ label: string; date: string; dateTime: string }> = [
  { label: "Czech", date: "d.m.Y", dateTime: "d.m.Y H:i:s" },
  { label: "ISO", date: "Y-m-d", dateTime: "Y-m-d H:i" },
  { label: "US", date: "n/j/Y", dateTime: "n/j/Y H:i" },
  { label: "System locale", date: SYSTEM_FORMAT, dateTime: SYSTEM_FORMAT },
];

function FormatsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const [date, setDate] = useState(DEFAULT_FORMATS.date);
  const [dateTime, setDateTime] = useState(DEFAULT_FORMATS.dateTime);

  useEffect(() => {
    const f = settings.data?.formats;
    setDate(f?.date || DEFAULT_FORMATS.date);
    setDateTime(f?.dateTime || DEFAULT_FORMATS.dateTime);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        formats: {
          // Persist only real customizations — the default stays implicit.
          date: date.trim() && date.trim() !== DEFAULT_FORMATS.date ? date.trim() : null,
          dateTime:
            dateTime.trim() && dateTime.trim() !== DEFAULT_FORMATS.dateTime ? dateTime.trim() : null,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const now = Date.now();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        How dates and times render everywhere in Cadence. Patterns use PHP-style tokens:{" "}
        <code className="rounded bg-muted px-1 font-mono">d m Y H i s</code> (padded) ·{" "}
        <code className="rounded bg-muted px-1 font-mono">j n G y</code> (plain). Default is Czech:{" "}
        <code className="rounded bg-muted px-1 font-mono">d.m.Y H:i:s</code>.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {FORMAT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setDate(p.date);
              setDateTime(p.dateTime);
            }}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs transition-colors",
              date === p.date && dateTime === p.dateTime
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/40",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Date format (deadlines, calendar)
        <input value={date} onChange={(e) => setDate(e.target.value)} className={cn(FIELD, "font-mono")} />
        <span className="text-[11px]">Preview: {formatTimestamp(now, date, "date")}</span>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Date &amp; time format (timelines, sessions)
        <input
          value={dateTime}
          onChange={(e) => setDateTime(e.target.value)}
          className={cn(FIELD, "font-mono")}
        />
        <span className="text-[11px]">Preview: {formatTimestamp(now, dateTime, "dateTime")}</span>
      </label>

      <div className="flex items-center justify-end gap-3">
        {save.isSuccess ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-500">
            <Check className="size-3.5" /> Saved
          </span>
        ) : null}
        <LabeledIconButton
          icon={<Save />}
          label="Save formats"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Code review (6.5.h)

const STRICTNESS_OPTIONS = [
  { value: "lenient", label: "Lenient", help: "Blockers and majors only — quick passes." },
  { value: "standard", label: "Standard", help: "Skips style nits a formatter would catch. (Default)" },
  { value: "strict", label: "Strict", help: "Everything, including minor issues and nits." },
];

function ReviewSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const [strictness, setStrictness] = useState("standard");

  useEffect(() => {
    setStrictness(settings.data?.review?.strictness ?? "standard");
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        review: { strictness: strictness !== "standard" ? strictness : null },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        How the <strong>Code reviewer</strong> agent behaves (perform direction). Publishing is
        always an explicit click in the Review Workspace — nothing ever auto-posts. The agent
        prompts themselves are editable under <strong>Agents &amp; Prompts</strong>.
      </p>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-muted-foreground">Review strictness</legend>
        {STRICTNESS_OPTIONS.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors",
              strictness === o.value ? "border-primary/50 bg-primary/5" : "border-border bg-card/40",
            )}
          >
            <input
              type="radio"
              name="strictness"
              value={o.value}
              checked={strictness === o.value}
              onChange={() => setStrictness(o.value)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex items-center justify-end gap-3">
        {save.isSuccess ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-500">
            <Check className="size-3.5" /> Saved
          </span>
        ) : null}
        <LabeledIconButton
          icon={<Save />}
          label="Save review settings"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Operations (6.3.e)

const OPS_FIELDS: Array<{ key: string; label: string; help: string; fallback: number }> = [
  {
    key: "stuckThresholdMinutes",
    label: "“Looks stuck” after (minutes)",
    help: "A running agent with no transcript activity for this long gets a stuck nudge.",
    fallback: 10,
  },
  {
    key: "readStageTimeoutMinutes",
    label: "Read-stage timeout (minutes)",
    help: "Hard stop for triage / discovery / questioner / planner / delivery runs.",
    fallback: 15,
  },
  {
    key: "implementStageTimeoutMinutes",
    label: "Implement/verify timeout (minutes)",
    help: "Hard stop for implementer and verifier runs (real builds + tests take longer).",
    fallback: 60,
  },
  {
    key: "maxStageAttemptsPer24h",
    label: "Max automatic retries per stage / 24 h",
    help: "Circuit breaker for Cadence-initiated respawns (self-heal): past this, the task flips to Needs input instead of spawning again. Actions you trigger yourself (PLAY, Refine) are never blocked.",
    fallback: 3,
  },
  {
    key: "maxConcurrentAgents",
    label: "Max concurrent agents",
    help: "Global cap on simultaneously-running background agents (the money valve).",
    fallback: 4,
  },
  {
    key: "askWaitMinutes",
    label: "Wait for your answer (minutes)",
    help: "When an agent asks you something mid-run, the run pauses this long for your answer (the stage timeout clock pauses too); then it continues on its own stated assumptions.",
    fallback: 10,
  },
];

function OperationsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const ops = (settings.data?.operations ?? {}) as Record<string, number | undefined>;
    setValues(Object.fromEntries(OPS_FIELDS.map((f) => [f.key, ops[f.key]?.toString() ?? ""])));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        operations: Object.fromEntries(
          OPS_FIELDS.map((f) => {
            const n = Number(values[f.key]);
            // blank or the default → clear (keep only real customizations)
            const customized = values[f.key]?.trim() && Number.isFinite(n) && n > 0 && n !== f.fallback;
            return [f.key, customized ? n : null];
          }),
        ),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Safety limits for background agents (§6.1). Blank = the built-in default; every limit guards
        real money, so values must be positive.
      </p>
      {OPS_FIELDS.map((f) => (
        <label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
          {f.label}
          <input
            type="number"
            min={1}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            placeholder={String(f.fallback)}
            className={FIELD}
          />
          <span className="text-[11px]">{f.help}</span>
        </label>
      ))}
      <div className="flex items-center justify-end gap-3">
        {save.isSuccess ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-500">
            <Check className="size-3.5" /> Saved
          </span>
        ) : null}
        <LabeledIconButton
          icon={<Save />}
          label="Save limits"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Agents & Prompts (6.3.c)

const MODEL_OPTIONS = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"];

/** Short chip text for a model id ("claude-sonnet-4-6" → "sonnet"). */
function modelShort(model: string | null | undefined): string {
  if (!model) return "auto";
  const m = model.match(/claude-(\w+)/);
  return m?.[1] ?? model;
}

function AgentsPromptsSection() {
  const prompts = useQuery({ queryKey: ["agent-prompts"], queryFn: getAgentPrompts });
  const list = prompts.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);

  const stages = list.filter((d) => d.kind === "stage");
  const subagents = list.filter((d) => d.kind === "subagent");
  const current = list.find((d) => d.role === selected) ?? stages[0] ?? list[0];

  const trySelect = (role: string) => {
    if (role === current?.role) return;
    if (dirty) setPendingSwitch(role); // unsaved-changes guard — the editor shows the choice
    else setSelected(role);
  };

  const Group = ({ title, items }: { title: string; items: AgentPromptInfo[] }) => (
    <>
      <div className="mt-3 mb-1 px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground first:mt-0">
        {title}
      </div>
      {items.map((d) => {
        const customized = d.override != null;
        const effectiveModel = d.override?.model ?? d.defaultModel;
        return (
          <button
            key={d.role}
            type="button"
            onClick={() => trySelect(d.role)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
              current?.role === d.role
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            <span className="truncate">{d.label}</span>
            {customized ? (
              <span title="Customized — differs from the default" className="size-1.5 shrink-0 rounded-full bg-amber-400" />
            ) : null}
            <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              {modelShort(effectiveModel)}
            </span>
          </button>
        );
      })}
    </>
  );

  return (
    <div className="flex items-start gap-4">
      <nav aria-label="Agents" className="w-56 shrink-0 rounded-lg border border-border bg-card/30 p-2">
        {prompts.isLoading ? <div className="p-2 text-xs text-muted-foreground">Loading agents…</div> : null}
        <Group title="Pipeline stages" items={stages} />
        <Group title="Subagents (library)" items={subagents} />
      </nav>
      {current ? (
        <AgentEditor
          key={current.role}
          def={current}
          onDirtyChange={setDirty}
          pendingSwitch={pendingSwitch}
          onConfirmSwitch={() => {
            if (pendingSwitch) setSelected(pendingSwitch);
            setPendingSwitch(null);
            setDirty(false);
          }}
          onCancelSwitch={() => setPendingSwitch(null)}
        />
      ) : null}
    </div>
  );
}

function AgentEditor({
  def,
  onDirtyChange,
  pendingSwitch,
  onConfirmSwitch,
  onCancelSwitch,
}: {
  def: AgentPromptInfo;
  onDirtyChange: (dirty: boolean) => void;
  pendingSwitch: string | null;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
}) {
  const qc = useQueryClient();
  const savedPrompt = def.override?.prompt ?? def.defaultTemplate;
  const savedModel = def.override?.model ?? "";
  const [prompt, setPrompt] = useState(savedPrompt);
  const [model, setModel] = useState(savedModel);
  const [resetArmed, setResetArmed] = useState(false);

  const dirty = prompt !== savedPrompt || model !== savedModel;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["agent-prompts"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
  };

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        agents: {
          // Persist only real customizations: a prompt equal to the default clears the
          // override (null), so "customized" honestly means "differs from default".
          [def.role]: {
            prompt: prompt !== def.defaultTemplate ? prompt : null,
            model: model || null,
          },
        },
      }),
    onSuccess: invalidate,
  });

  const reset = useMutation({
    mutationFn: () => updateSettings({ agents: { [def.role]: null } }),
    onSuccess: () => {
      setPrompt(def.defaultTemplate);
      setModel("");
      setResetArmed(false);
      invalidate();
    },
  });

  const rows = Math.min(28, Math.max(8, prompt.split("\n").length + 1));

  return (
    <div className="min-w-0 flex-1 rounded-lg border border-border bg-card/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{def.label}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{def.description}</p>
        </div>
        {def.override != null ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
            customized
          </span>
        ) : null}
      </div>

      {pendingSwitch ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <span>You have unsaved changes here.</span>
          <span className="flex gap-2">
            <button type="button" onClick={onConfirmSwitch} className="rounded border border-border px-2 py-0.5 hover:border-red-500/60 hover:text-red-400">
              Discard &amp; switch
            </button>
            <button type="button" onClick={onCancelSwitch} className="rounded border border-primary/50 bg-primary/10 px-2 py-0.5">
              Keep editing
            </button>
          </span>
        </div>
      ) : null}

      {def.variables.length > 0 ? (
        <div className="mt-3">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Variables (filled in by Cadence per run)
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {def.variables.map((v) => (
              <li key={v.name} className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
                <code className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground/80">{`{{${v.name}}}`}</code>
                <span>{v.doc}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
        Prompt template
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={rows}
          spellCheck={false}
          className={cn(FIELD, "font-mono text-xs leading-relaxed")}
        />
      </label>

      <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
        Model for this agent
        <SelectBox
          label="Model for this agent"
          value={model}
          onChange={setModel}
          options={[
            { value: "", label: `Default (${def.defaultModel ?? "claude default"})` },
            ...MODEL_OPTIONS.map((m) => ({ value: m, label: m })),
            ...(model && !MODEL_OPTIONS.includes(model) ? [{ value: model, label: model }] : []),
          ]}
        />
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          disabled={reset.isPending || (def.override == null && !dirty)}
          onClick={() => {
            if (!resetArmed) {
              setResetArmed(true);
              window.setTimeout(() => setResetArmed(false), 4000);
              return;
            }
            reset.mutate();
          }}
          className={cn(
            "rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40",
            resetArmed
              ? "border-red-500/60 bg-red-500/10 text-red-400"
              : "border-border text-muted-foreground hover:border-primary/40",
          )}
        >
          {resetArmed ? "✓ Confirm reset" : "↺ Reset to default"}
        </button>
        <div className="flex items-center gap-3">
          {save.isSuccess && !dirty ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-500">
              <Check className="size-3.5" /> Saved
            </span>
          ) : null}
          <LabeledIconButton
            icon={<Save />}
            label="Save agent"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          />
        </div>
      </div>
    </div>
  );
}
