import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, HelpCircle, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { type FlowControls, FlowStrip } from "../../components/FlowStrip";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getApprovals, resolveApproval } from "../../lib/api";

/**
 * A parked live-run request, as a centered modal step in the flow. Two shapes:
 * - AskUserQuestion → the agent's actual questions, answerable inline (radio /
 *   checkbox / free text); submitting feeds the answers back INTO the paused run,
 *   which then continues.
 * - any other tool → the Manual-mode approve/deny gate.
 * Resolving advances the flow.
 */

/** AskUserQuestion's input shape (kept permissive — options may be strings). */
interface AskQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label?: string; description?: string } | string>;
}

function askQuestions(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  return Array.isArray(qs) ? (qs as AskQuestion[]) : [];
}

function optionLabel(o: { label?: string; description?: string } | string): string {
  return (typeof o === "string" ? o : (o?.label ?? "")).trim();
}

function optionDescription(o: { label?: string; description?: string } | string): string {
  return typeof o === "string" ? "" : (o?.description ?? "").trim();
}

export function ToolApprovalModal({
  approvalId,
  flow,
  onResolved,
  onClose,
}: {
  approvalId: string;
  flow?: FlowControls;
  onResolved: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: getApprovals, refetchInterval: 2000 });
  const req = approvals.data?.find((a) => a.id === approvalId);
  // Per-question answers keyed by question text; multi-select holds string[].
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const resolve = useMutation({
    mutationFn: (d: { allow: boolean; answers?: Record<string, string | string[]> }) =>
      resolveApproval(approvalId, d.allow, d.answers),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      onResolved();
    },
  });

  const questions = req?.toolName === "AskUserQuestion" ? askQuestions(req.input) : [];
  const isAsk = questions.length > 0;

  const valueOf = (q: AskQuestion): string | string[] => {
    const key = q.question ?? "";
    return answers[key] ?? (q.multiSelect ? [] : "");
  };
  const setAnswer = (q: AskQuestion, v: string | string[]) =>
    setAnswers((p) => ({ ...p, [q.question ?? ""]: v }));

  const submitAnswers = () => {
    // Free-text ("Other") wins over a picked option for that question.
    const finalAnswers: Record<string, string | string[]> = {};
    for (const q of questions) {
      const key = (q.question ?? "").trim();
      if (!key) continue;
      const typed = (other[key] ?? "").trim();
      const picked = valueOf(q);
      const value = typed !== "" ? typed : picked;
      if (value !== "" && !(Array.isArray(value) && value.length === 0)) finalAnswers[key] = value;
    }
    resolve.mutate({ allow: true, answers: finalAnswers });
  };

  const answeredAll = questions.every((q) => {
    const key = (q.question ?? "").trim();
    const typed = (other[key] ?? "").trim();
    const picked = valueOf(q);
    return typed !== "" || (Array.isArray(picked) ? picked.length > 0 : picked !== "");
  });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="my-auto flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {flow ? <FlowStrip flow={flow} /> : null}
        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <h2
              className={`flex items-center gap-2 text-base font-semibold ${isAsk ? "text-amber-300" : "text-red-300"}`}
            >
              {isAsk ? (
                <>
                  <HelpCircle className="size-5" /> An agent is asking you
                </>
              ) : (
                <>
                  <ShieldQuestion className="size-5" /> Tool action awaiting approval
                </>
              )}
            </h2>
            <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {isAsk
              ? "The run is paused and waiting for your answer — it continues the moment you submit."
              : "A live agent is blocked (Manual mode) until you decide."}
          </p>

          {!req ? (
            <p className="mt-3 text-sm text-muted-foreground">This request was already resolved.</p>
          ) : isAsk ? (
            <div className="mt-4 flex flex-col gap-5">
              {questions.map((q, qi) => {
                const key = (q.question ?? "").trim();
                const options = (q.options ?? []).map(optionLabel).filter(Boolean);
                return (
                  <div key={`${qi}-${key}`}>
                    {q.header?.trim() ? (
                      <span className="mb-1 inline-block rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                        {q.header.trim()}
                      </span>
                    ) : null}
                    <div className="text-sm font-medium">{q.question}</div>
                    <div className="mt-2 flex flex-col gap-1.5 text-sm">
                      {(q.options ?? []).map((o, oi) => {
                        const label = optionLabel(o);
                        if (!label) return null;
                        const desc = optionDescription(o);
                        const picked = valueOf(q);
                        return (
                          <label key={`${oi}-${label}`} className="flex items-start gap-2">
                            {q.multiSelect ? (
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={Array.isArray(picked) && picked.includes(label)}
                                onChange={(e) => {
                                  const arr = Array.isArray(picked) ? picked : [];
                                  setAnswer(
                                    q,
                                    e.target.checked ? [...arr, label] : arr.filter((x) => x !== label),
                                  );
                                }}
                              />
                            ) : (
                              <input
                                type="radio"
                                className="mt-0.5"
                                name={`ask-${qi}`}
                                checked={picked === label}
                                onChange={() => setAnswer(q, label)}
                              />
                            )}
                            <span>
                              {label}
                              {desc ? (
                                <span className="block text-xs text-muted-foreground">{desc}</span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}
                      <input
                        value={other[key] ?? ""}
                        onChange={(e) => setOther((p) => ({ ...p, [key]: e.target.value }))}
                        placeholder={options.length ? "Or answer in your own words…" : "Your answer…"}
                        aria-label={`${q.question} — your own answer`}
                        className="mt-1 rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{req.toolName}</span>
              <code className="flex-1 truncate text-xs text-muted-foreground">
                {typeof req.input === "string" ? req.input : JSON.stringify(req.input)}
              </code>
            </div>
          )}

          <div className="mt-5 flex items-center gap-2">
            {isAsk ? (
              <>
                <button
                  type="button"
                  onClick={submitAnswers}
                  disabled={resolve.isPending || !req || !answeredAll}
                  className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-60"
                >
                  <Check className="size-4" /> Send answers — continue the run
                </button>
                <button
                  type="button"
                  onClick={() => resolve.mutate({ allow: false })}
                  disabled={resolve.isPending || !req}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:border-amber-500/50 hover:text-amber-400 disabled:opacity-60"
                >
                  <X className="size-4" /> Skip — let the agent decide
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => resolve.mutate({ allow: true })}
                  disabled={resolve.isPending || !req}
                  className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-60"
                >
                  <Check className="size-4" /> Approve
                </button>
                <button
                  type="button"
                  onClick={() => resolve.mutate({ allow: false })}
                  disabled={resolve.isPending || !req}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:border-red-500/50 hover:text-red-400 disabled:opacity-60"
                >
                  <X className="size-4" /> Deny
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
