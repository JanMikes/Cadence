import type {
  ReviewFinding,
  ReviewFindings,
  ReviewProposal,
  TaskDetail,
} from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SelectBox } from "../../components/SelectBox";
import {
  approvePlan,
  getReviewFindings,
  getReviewProposal,
  postReviewReplies,
  publishReview,
  saveReviewFindings,
  saveReviewProposal,
} from "../../lib/api";
import { cn } from "../../lib/utils";

/**
 * The Review Workspace (§6.5.e/f) — lives inside TaskDetail for code_review tasks.
 * Perform direction: triage the reviewer's findings (Include · Edit · Dismiss), pick a
 * verdict, then EXPLICITLY publish (or copy as markdown — nothing ever auto-posts).
 * Address direction: review the responder's per-thread proposal (Apply · Edit · Skip),
 * approve to run the apply phase, then EXPLICITLY post replies + resolve.
 */

const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"] as const;
const SEVERITY_STYLE: Record<string, string> = {
  blocker: "bg-red-500/15 text-red-400",
  major: "bg-orange-500/15 text-orange-400",
  minor: "bg-amber-500/15 text-amber-300",
  nit: "bg-muted text-muted-foreground",
};
const CLASSIFICATION_STYLE: Record<string, string> = {
  must_fix: "bg-red-500/15 text-red-400",
  question: "bg-sky-500/15 text-sky-400",
  preference: "bg-amber-500/15 text-amber-300",
  pushback: "bg-purple-500/15 text-purple-300",
};
const CLASSIFICATION_LABEL: Record<string, string> = {
  must_fix: "must fix",
  question: "question",
  preference: "preference",
  pushback: "push back",
};

/** Copy-ready markdown of the included findings (exported for tests). */
export function findingsToMarkdown(f: ReviewFindings): string {
  const included = f.findings.filter((x) => x.decision !== "dismiss");
  const lines = [`## Review summary`, "", f.summary, "", `Verdict: ${f.verdictSuggestion}`, ""];
  for (const sev of SEVERITY_ORDER) {
    const group = included.filter((x) => x.severity === sev);
    if (!group.length) continue;
    lines.push(`### ${sev[0]?.toUpperCase()}${sev.slice(1)}s`, "");
    for (const x of group) {
      lines.push(`- **${x.file}:${x.line}** — ${x.title}`, `  ${x.editedBody ?? x.body}`);
      if (x.suggestedPatch) lines.push("  ```", `  ${x.suggestedPatch.split("\n").join("\n  ")}`, "  ```");
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function ReviewWorkspace({ task }: { task: TaskDetail }) {
  if (task.taskType !== "code_review") return null;
  return task.reviewDirection === "address" ? (
    <AddressPane task={task} />
  ) : (
    <PerformPane task={task} />
  );
}

/** A closed task's workspace is a record, not a control panel — no triage buttons,
 *  no publish/post actions, no "press PLAY" prompts (same stale-panel family as
 *  PlanView/QACards). */
function isClosed(task: TaskDetail): boolean {
  return task.status === "done" || task.status === "cancelled";
}

function Header({ task, hint }: { task: TaskDetail; hint: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div>
        <h3 className="text-sm font-semibold">Review workspace</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {task.reviewRef ? (
        <a
          href={task.reviewRef}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-primary hover:underline"
        >
          Open {task.reviewDirection === "address" ? "my PR/MR" : "PR/MR"} ↗
        </a>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- perform (6.5.e)

function PerformPane({ task }: { task: TaskDetail }) {
  const qc = useQueryClient();
  const findings = useQuery({
    queryKey: ["review-findings", task.id],
    queryFn: () => getReviewFindings(task.id),
  });
  const [verdict, setVerdict] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [publishArmed, setPublishArmed] = useState(false);
  const [copied, setCopied] = useState(false);

  const data = findings.data ?? null;
  const effectiveVerdict = verdict ?? data?.verdictSuggestion ?? "comment";
  const included = data?.findings.filter((f) => f.decision !== "dismiss") ?? [];

  const save = useMutation({
    mutationFn: (next: ReviewFindings) => saveReviewFindings(task.id, next),
    onSuccess: (next) => qc.setQueryData(["review-findings", task.id], next),
  });
  const publish = useMutation({
    mutationFn: () => publishReview(task.id, effectiveVerdict),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["review-findings", task.id] });
      void qc.invalidateQueries({ queryKey: ["task"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      setPublishArmed(false);
    },
  });

  const patchFinding = (index: number, patch: Partial<ReviewFinding>) => {
    if (!data) return;
    const next = {
      ...data,
      findings: data.findings.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    };
    save.mutate(next);
  };

  const closed = isClosed(task);

  if (findings.isLoading) {
    return <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 text-xs text-muted-foreground">Loading review…</section>;
  }
  if (!data) {
    return (
      <section className="mt-6 rounded-lg border border-border bg-card/40 p-4">
        <Header
          task={task}
          hint={
            closed
              ? "This review task is closed — no findings were recorded."
              : "No findings yet — press PLAY to run the reviewer."
          }
        />
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-lg border border-border bg-card/40 p-4">
      <Header
        task={task}
        hint={
          data.published
            ? `Published ${data.published.verdict} — nothing auto-posts without you.`
            : closed
              ? "Task closed — these findings were never published."
              : "Triage the findings, then publish or copy. Nothing posts without your confirm."
        }
      />

      {data.summary ? (
        <p className="mt-3 whitespace-pre-wrap rounded-md bg-background/60 p-3 text-xs">{data.summary}</p>
      ) : null}

      <ul className="mt-3 flex flex-col gap-2">
        {data.findings.length === 0 ? (
          <li className="text-xs text-muted-foreground">No findings — clean change 🎉</li>
        ) : null}
        {SEVERITY_ORDER.flatMap((sev) =>
          data.findings
            .map((f, index) => ({ f, index }))
            .filter(({ f }) => f.severity === sev)
            .map(({ f, index }) => (
              <li
                key={`${f.file}:${f.line}:${index}`}
                className={cn(
                  "rounded-md border border-border bg-background/60 p-3",
                  f.decision === "dismiss" && "opacity-50",
                )}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", SEVERITY_STYLE[f.severity])}>
                    {f.severity}
                  </span>
                  <code className="font-mono text-[11px]">{f.file}:{f.line}</code>
                  <span className="font-medium">{f.title}</span>
                  {!closed ? (
                    <span className="ml-auto flex shrink-0 gap-1">
                      {f.decision === "dismiss" ? (
                        <WorkspaceButton label="↩ Restore" onClick={() => patchFinding(index, { decision: "include" })} />
                      ) : (
                        <>
                          <WorkspaceButton label="✎ Edit" onClick={() => setEditing(editing === index ? null : index)} />
                          <WorkspaceButton danger label="✕ Dismiss" onClick={() => patchFinding(index, { decision: "dismiss" })} />
                        </>
                      )}
                    </span>
                  ) : null}
                </div>
                {editing === index ? (
                  <textarea
                    defaultValue={f.editedBody ?? f.body}
                    rows={3}
                    autoFocus
                    onBlur={(e) => {
                      patchFinding(index, { editedBody: e.target.value });
                      setEditing(null);
                    }}
                    className="mt-2 w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs outline-none"
                  />
                ) : (
                  <p className="mt-1.5 whitespace-pre-wrap text-xs text-foreground/90">{f.editedBody ?? f.body}</p>
                )}
                {f.suggestedPatch ? (
                  <pre className="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-snug">
                    {f.suggestedPatch}
                  </pre>
                ) : null}
              </li>
            )),
        )}
      </ul>

      {closed && !data.published ? (
        // Closed without publishing: keep the record copyable, drop the controls.
        <div className="mt-4 flex justify-end border-t border-border pt-3">
          <WorkspaceButton
            label={copied ? "✓ Copied" : "⧉ Copy as Markdown"}
            onClick={() => {
              void navigator.clipboard?.writeText(findingsToMarkdown(data));
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          />
        </div>
      ) : !data.published ? (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            Verdict
            <SelectBox
              label="Verdict"
              size="sm"
              className="w-40"
              value={effectiveVerdict}
              onChange={setVerdict}
              options={[
                { value: "comment", label: "Comment" },
                { value: "approve", label: "Approve" },
                { value: "request_changes", label: "Request changes" },
              ]}
            />
          </div>
          <WorkspaceButton
            label={copied ? "✓ Copied" : "⧉ Copy as Markdown"}
            onClick={() => {
              void navigator.clipboard?.writeText(findingsToMarkdown(data));
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          />
          <button
            type="button"
            disabled={publish.isPending}
            onClick={() => {
              if (!publishArmed) {
                setPublishArmed(true);
                window.setTimeout(() => setPublishArmed(false), 5000);
                return;
              }
              publish.mutate();
            }}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
              publishArmed
                ? "border-red-500/60 bg-red-500/10 text-red-400"
                : "border-primary/50 bg-primary/10",
            )}
          >
            {publish.isPending
              ? "Publishing…"
              : publishArmed
                ? `✓ Confirm: post ${included.length} comment${included.length === 1 ? "" : "s"} + ${effectiveVerdict.replace("_", " ")}`
                : "▲ Publish review"}
          </button>
          {publish.isError ? <span className="text-xs text-red-400">Publish failed — see task context.</span> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-emerald-400">
          ✓ Published{data.published.url ? " — " : ""}
          {data.published.url ? (
            <a href={data.published.url} target="_blank" rel="noreferrer" className="underline">
              view on the forge
            </a>
          ) : null}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- address (6.5.f)

function AddressPane({ task }: { task: TaskDetail }) {
  const qc = useQueryClient();
  const proposal = useQuery({
    queryKey: ["review-proposal", task.id],
    queryFn: () => getReviewProposal(task.id),
  });
  const [editing, setEditing] = useState<number | null>(null);
  const [postArmed, setPostArmed] = useState(false);

  const data = proposal.data ?? null;
  const save = useMutation({
    mutationFn: (next: ReviewProposal) => saveReviewProposal(task.id, next),
    onSuccess: (next) => qc.setQueryData(["review-proposal", task.id], next),
  });
  const approve = useMutation({
    mutationFn: () => approvePlan(task.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["task"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const post = useMutation({
    mutationFn: () => postReviewReplies(task.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["review-proposal", task.id] });
      void qc.invalidateQueries({ queryKey: ["task"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      setPostArmed(false);
    },
  });

  const patchThread = (index: number, patch: Partial<ReviewProposal["threads"][number]>) => {
    if (!data) return;
    const next = { ...data, threads: data.threads.map((t, i) => (i === index ? { ...t, ...patch } : t)) };
    save.mutate(next);
  };

  const closed = isClosed(task);

  if (proposal.isLoading) {
    return <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 text-xs text-muted-foreground">Loading proposal…</section>;
  }
  if (!data) {
    return (
      <section className="mt-6 rounded-lg border border-border bg-card/40 p-4">
        <Header
          task={task}
          hint={
            closed
              ? "This review task is closed — no proposal was recorded."
              : "No proposal yet — press PLAY to fetch and triage the feedback."
          }
        />
      </section>
    );
  }

  const active = data.threads.filter((t) => t.decision !== "skip");
  return (
    <section className="mt-6 rounded-lg border border-border bg-card/40 p-4">
      <Header
        task={task}
        hint={
          closed
            ? data.repliedAt
              ? "Task closed — replies were posted."
              : "Task closed — these replies were never posted."
            : "Per-thread proposals: Apply runs after your approval; replies post only on your confirm."
        }
      />
      {data.overallNote ? <p className="mt-2 text-xs text-muted-foreground">{data.overallNote}</p> : null}

      <ul className="mt-3 flex flex-col gap-2">
        {data.threads.length === 0 ? (
          <li className="text-xs text-emerald-400">
            {closed ? "No unresolved feedback 🎉" : "No unresolved feedback 🎉 — mark the task done when ready."}
          </li>
        ) : null}
        {data.threads.map((t, index) => (
          <li
            key={t.threadId}
            className={cn("rounded-md border border-border bg-background/60 p-3", t.decision === "skip" && "opacity-50")}
          >
            <div className="flex items-center gap-2 text-xs">
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", CLASSIFICATION_STYLE[t.classification] ?? "bg-muted")}>
                {CLASSIFICATION_LABEL[t.classification] ?? t.classification}
              </span>
              <code className="font-mono text-[11px] text-muted-foreground">{t.threadId}</code>
              {t.resolves ? <span className="text-[10px] text-muted-foreground">will resolve</span> : null}
              {!closed ? (
                <span className="ml-auto flex shrink-0 gap-1">
                  {t.decision === "skip" ? (
                    <WorkspaceButton label="↩ Include" onClick={() => patchThread(index, { decision: "apply" })} />
                  ) : (
                    <>
                      <WorkspaceButton label="✎ Edit reply" onClick={() => setEditing(editing === index ? null : index)} />
                      <WorkspaceButton danger label="⤼ Skip" onClick={() => patchThread(index, { decision: "skip" })} />
                    </>
                  )}
                </span>
              ) : null}
            </div>
            {editing === index ? (
              <textarea
                defaultValue={t.editedReply ?? t.reply}
                rows={2}
                autoFocus
                onBlur={(e) => {
                  patchThread(index, { editedReply: e.target.value });
                  setEditing(null);
                }}
                className="mt-2 w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs outline-none"
              />
            ) : (
              <p className="mt-1.5 whitespace-pre-wrap text-xs text-foreground/90">{t.editedReply ?? t.reply}</p>
            )}
            {t.patch ? (
              <pre className="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-snug">{t.patch}</pre>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        {task.status === "plan_review" ? (
          <button
            type="button"
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
            className="rounded-md border border-primary/50 bg-primary/10 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            {approve.isPending ? "Starting…" : "✔ Approve & apply fixes"}
          </button>
        ) : null}
        {task.status === "review" && !data.repliedAt ? (
          <button
            type="button"
            disabled={post.isPending}
            onClick={() => {
              if (!postArmed) {
                setPostArmed(true);
                window.setTimeout(() => setPostArmed(false), 5000);
                return;
              }
              post.mutate();
            }}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
              postArmed ? "border-red-500/60 bg-red-500/10 text-red-400" : "border-primary/50 bg-primary/10",
            )}
          >
            {post.isPending
              ? "Posting…"
              : postArmed
                ? `✓ Confirm: post ${active.filter((t) => (t.editedReply ?? t.reply).trim()).length} replies`
                : "▲ Post replies & resolve"}
          </button>
        ) : null}
        {data.repliedAt ? <span className="text-xs text-emerald-400">✓ Replies posted</span> : null}
      </div>
    </section>
  );
}

function WorkspaceButton({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
        danger
          ? "border-border text-muted-foreground hover:border-red-500/60 hover:text-red-400"
          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
