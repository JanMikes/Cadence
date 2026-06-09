import { DELIVERY_MODES, PERMISSION_MODES, TERMINAL_APPS } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getSettings, updateSettings } from "../../lib/api";
import { getAutostart, isTauri, setAutostart } from "../../lib/tauri";

const FIELD =
  "rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

export function SettingsView() {
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
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Global defaults (overridable per project/task) and the preferred terminal for handoff.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card/40 p-4">
          <div>
            <div className="text-sm font-medium">Autonomy</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              When on, Cadence triages and refines every captured task automatically (spawns Claude in
              the background). Off by default; override per project.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autonomy}
            aria-label="Autonomy"
            onClick={() => setAutonomy((v) => !v)}
            className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              autonomy ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block size-5 rounded-full bg-white transition-transform ${
                autonomy ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        {inTauri ? (
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card/40 p-4">
            <div>
              <div className="text-sm font-medium">Launch at login</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Start Cadence automatically when you log in (to the menubar). Desktop app only.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={launchAtLogin}
              aria-label="Launch at login"
              onClick={() => void toggleLaunchAtLogin()}
              className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                launchAtLogin ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block size-5 rounded-full bg-white transition-transform ${
                  launchAtLogin ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        ) : null}

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Preferred terminal (for one-click handoff)
          <select value={terminal} onChange={(e) => setTerminal(e.target.value)} className={FIELD}>
            {TERMINAL_APPS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Default permission mode
          <select value={perm} onChange={(e) => setPerm(e.target.value)} className={FIELD}>
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Default delivery mode
          <select value={delivery} onChange={(e) => setDelivery(e.target.value)} className={FIELD}>
            {DELIVERY_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

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
    </div>
  );
}
