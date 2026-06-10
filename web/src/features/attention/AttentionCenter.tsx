import type { AttentionItem, AttentionKind } from "@cadence/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, GitMerge, HelpCircle, ListChecks, Play, ShieldQuestion, Sparkles, X } from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import type { FlowControls } from "../../components/FlowStrip";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { getProjects } from "../../lib/api";
import { cn } from "../../lib/utils";
import { PriorityBadge, ProjectChip } from "../board/Board";
import { TaskDetail } from "../task/TaskDetail";
import { ToolApprovalModal } from "./ToolApprovalModal";
import { useAttention } from "./useAttention";

const KIND_META: Record<AttentionKind, { icon: ComponentType<{ className?: string }>; tint: string }> = {
  needs_input: { icon: HelpCircle, tint: "text-amber-400" },
  plan_approval: { icon: ListChecks, tint: "text-violet-300" },
  review_merge: { icon: GitMerge, tint: "text-green-400" },
  tool_approval: { icon: ShieldQuestion, tint: "text-red-300" },
  stalled: { icon: AlertTriangle, tint: "text-red-300" },
};

/**
 * The Attention Center (§10): the single place that shows everything Cadence is waiting on, and
 * lets the user power through it. A LIST modal to scan/pick any item, and a focused FLOW that
 * opens each item **directly in its task modal** (or the tool-approval modal) — resolving advances
 * to the next ("resolve one → serve the next"). The live feed (useAttention) drives the advance:
 * once an item is no longer waiting it drops out and the same cursor slides to the next.
 */
export function AttentionCenter({
  onClose,
  onOpenSession,
  onOpenSessionDetail,
  onOpenTask,
}: {
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenSessionDetail?: (sessionId: string) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const qc = useQueryClient();
  const attention = useAttention();
  const items = attention.data?.items ?? [];

  const [mode, setMode] = useState<"list" | "flow">("list");
  const [flowIndex, setFlowIndex] = useState(0);

  const advance = () => void qc.invalidateQueries({ queryKey: ["attention"] });
  const openFlow = (i: number) => {
    setFlowIndex(i);
    setMode("flow");
  };
  const skip = () => setFlowIndex((i) => (items.length ? (i + 1) % items.length : 0));

  if (mode === "flow") {
    const idx = Math.min(flowIndex, items.length - 1);
    const current = idx >= 0 ? items[idx] : undefined;
    if (!current) return <AllClearModal onClose={onClose} />;

    const flow: FlowControls = { index: idx, total: items.length, onSkip: skip, onExit: () => setMode("list") };

    if (current.kind === "tool_approval" && current.approvalId) {
      return (
        <ToolApprovalModal
          key={current.id}
          approvalId={current.approvalId}
          flow={flow}
          onResolved={advance}
          onClose={onClose}
        />
      );
    }
    if (current.taskId) {
      // Open the task itself, full-space, in its modal — the resolver (Q&A / plan / review) and all
      // context live there. key forces a fresh mount as the cursor moves to the next task.
      return (
        <TaskDetail
          key={current.taskId}
          taskId={current.taskId}
          onClose={onClose}
          onOpenSession={onOpenSession}
          onOpenSessionDetail={onOpenSessionDetail}
          onOpenTask={onOpenTask}
          flow={flow}
          onResolved={advance}
        />
      );
    }
    return null;
  }

  return (
    <ListModal
      items={items}
      loading={attention.isLoading}
      onClose={onClose}
      onStartFlow={() => openFlow(0)}
      onPick={openFlow}
    />
  );
}

function Backdrop({ children, onClose, max = "max-w-lg" }: { children: ReactNode; onClose: () => void; max?: string }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Close button is the keyboard path
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className={cn("my-auto flex w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl", max)}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ListModal({
  items,
  loading,
  onClose,
  onStartFlow,
  onPick,
}: {
  items: AttentionItem[];
  loading: boolean;
  onClose: () => void;
  onStartFlow: () => void;
  onPick: (i: number) => void;
}) {
  // Same cached query the board uses — joins each item's projectId to its name + color.
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const projectById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );
  return (
    <Backdrop onClose={onClose}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Sparkles className="size-5 text-primary" /> Needs you
          {items.length ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
              {items.length}
            </span>
          ) : null}
        </h2>
        <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
      </header>

      {items.length === 0 ? (
        <AllClear loading={loading} />
      ) : (
        <div className="flex flex-col gap-3 p-5">
          <button
            type="button"
            onClick={onStartFlow}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Play className="size-4 fill-current" /> Start flow — resolve them one by one
          </button>
          <ul className="flex flex-col gap-2">
            {items.map((item, i) => {
              const meta = KIND_META[item.kind];
              const Icon = meta.icon;
              const project = item.projectId ? projectById.get(item.projectId) : undefined;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onPick(i)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/50"
                  >
                    <Icon className={cn("size-4 shrink-0", meta.tint)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{item.title}</span>
                        {item.priority ? <PriorityBadge priority={item.priority} /> : null}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{item.summary}</span>
                        {project ? <ProjectChip project={project} /> : null}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                      {item.actionLabel} <ArrowRight className="size-3" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Backdrop>
  );
}

function AllClear({ loading }: { loading: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-green-500/15 text-green-400">
        <Check className="size-7" />
      </div>
      <p className="text-sm font-medium">{loading ? "Checking…" : "All clear ✨"}</p>
      <p className="max-w-[18rem] text-xs text-muted-foreground">
        {loading
          ? "Loading what needs your attention."
          : "Nothing is waiting on you. Cadence will ping you here the moment it needs something."}
      </p>
    </div>
  );
}

function AllClearModal({ onClose }: { onClose: () => void }) {
  return (
    <Backdrop onClose={onClose}>
      <header className="flex items-center justify-end border-b border-border px-5 py-4">
        <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
      </header>
      <AllClear loading={false} />
    </Backdrop>
  );
}
