import type { QAQuestion } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, HelpCircle } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getQa, submitAnswers } from "../../lib/api";

type Answer = string | string[];

/** Statuses where answers still feed the pipeline (capture → refinement → Ready).
 *  Once execution starts (or the task is closed) the card would be stale noise —
 *  answers can no longer steer the task. */
const INPUT_STATUSES = new Set(["inbox", "triaged", "refining", "needs_feedback", "ready", "blocked"]);

/** Mirrors the server's rule: non-empty string or non-empty selection. */
function isAnswered(a: Answer | undefined): boolean {
  if (a == null) return false;
  return Array.isArray(a) ? a.length > 0 : a.trim().length > 0;
}

/** The Needs-Feedback Q&A cards (§6/§10): ranked questions the user answers to
 *  unblock a task. Submitting answers advances the task (→ Ready when complete). */
export function QACards({
  taskId,
  status,
  onResolved,
}: {
  taskId: string;
  /** The task's current status — the card only shows while input is still consumed. */
  status: string;
  onResolved?: () => void;
}) {
  const qc = useQueryClient();
  const qa = useQuery({ queryKey: ["task", taskId, "qa"], queryFn: () => getQa(taskId) });
  const [draft, setDraft] = useState<Record<string, Answer>>({});

  const submit = useMutation({
    mutationFn: () => submitAnswers(taskId, draft),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      onResolved?.();
    },
  });

  const channel = qa.data;
  if (!channel || channel.questions.length === 0) return null;
  if (!INPUT_STATUSES.has(status)) return null;
  // Outside the explicit Needs-Feedback gate, only surface while something is
  // actually unanswered — answered Q&A is history, not a call to action.
  const hasOpen = channel.questions.some((q) => !isAnswered(channel.answers[q.id]));
  if (status !== "needs_feedback" && !hasOpen) return null;
  const questions = [...channel.questions].sort((a, b) => a.rank - b.rank);

  const valueOf = (q: QAQuestion): Answer =>
    draft[q.id] ?? channel.answers[q.id] ?? (q.type === "multi_choice" ? [] : "");
  const set = (id: string, v: Answer) => setDraft((p) => ({ ...p, [id]: v }));

  return (
    <section className="mt-5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
        <HelpCircle className="size-4" /> Needs your input
      </div>
      <div className="mt-3 flex flex-col gap-4">
        {questions.map((q) => (
          <div key={q.id}>
            <div className="text-sm font-medium">
              {q.rank}. {q.text}
            </div>
            {q.why ? <div className="text-xs text-muted-foreground">{q.why}</div> : null}
            <div className="mt-1.5">
              <AnswerInput q={q} value={valueOf(q)} onChange={(v) => set(q.id, v)} />
            </div>
          </div>
        ))}
      </div>
      {submit.isError ? <p className="mt-2 text-xs text-red-400">Couldn’t submit answers.</p> : null}
      <div className="mt-3 flex justify-end">
        <LabeledIconButton
          icon={<Check />}
          label="Submit answers"
          size="sm"
          onClick={() => submit.mutate()}
          disabled={submit.isPending}
        />
      </div>
    </section>
  );
}

function AnswerInput({
  q,
  value,
  onChange,
}: {
  q: QAQuestion;
  value: Answer;
  onChange: (v: Answer) => void;
}) {
  const field =
    "rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

  if (q.type === "single_choice" || q.type === "boolean") {
    const options = q.type === "boolean" ? ["yes", "no"] : (q.options ?? []);
    return (
      <div className="flex flex-wrap gap-3 text-sm">
        {options.map((opt) => (
          <label key={opt} className="inline-flex items-center gap-1.5">
            <input type="radio" name={q.id} checked={value === opt} onChange={() => onChange(opt)} />
            {opt}
          </label>
        ))}
      </div>
    );
  }

  if (q.type === "multi_choice") {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div className="flex flex-wrap gap-3 text-sm">
        {(q.options ?? []).map((opt) => (
          <label key={opt} className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={arr.includes(opt)}
              onChange={(e) =>
                onChange(e.target.checked ? [...arr, opt] : arr.filter((o) => o !== opt))
              }
            />
            {opt}
          </label>
        ))}
      </div>
    );
  }

  return (
    <input
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Your answer…"
      aria-label={q.text}
      className={`${field} w-full`}
    />
  );
}
