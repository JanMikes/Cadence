import { DELIVERY_MODES, PERMISSION_MODES, TERMINAL_APPS } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getSettings, updateSettings } from "../../lib/api";

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

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setTerminal(s.preferredTerminal);
    setPerm(s.global.defaultPermissionMode);
    setDelivery(s.global.defaultDeliveryMode);
    setModel(s.global.defaultModel ?? "");
    setPrompt(s.global.systemPrompt);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        preferredTerminal: terminal,
        global: {
          defaultPermissionMode: perm,
          defaultDeliveryMode: delivery,
          defaultModel: model.trim() || null,
          systemPrompt: prompt,
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
