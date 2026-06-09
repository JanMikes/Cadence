import { ChevronLeft, SkipForward, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";

/** Controls for the "needs you" focused flow — passed to whatever modal is the current step. */
export interface FlowControls {
  index: number;
  total: number;
  /** Advance to the next item without resolving this one. */
  onSkip: () => void;
  /** Leave the flow and go back to the full "needs you" list. */
  onExit: () => void;
}

/**
 * The slim header strip shown atop a modal when it's a step in the Attention flow:
 * "Needs you — i of N", progress dots, and Back-to-list / Skip. Lives in components/
 * so both the task modal and the tool-approval modal can wear it.
 */
export function FlowStrip({ flow }: { flow: FlowControls }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-300">
        <Sparkles className="size-3.5" />
        Needs you — {flow.index + 1} of {flow.total}
        <span className="flex items-center gap-1" aria-hidden>
          {Array.from({ length: Math.min(flow.total, 8) }).map((_, i) => (
            <span
              key={i}
              className={cn("size-1.5 rounded-full", i === flow.index ? "bg-amber-300" : "bg-amber-300/30")}
            />
          ))}
          {flow.total > 8 ? <span className="text-[10px]">+{flow.total - 8}</span> : null}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={flow.onExit}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-amber-200/80 transition-colors hover:bg-amber-500/15 hover:text-amber-100"
        >
          <ChevronLeft className="size-3.5" /> All items
        </button>
        <button
          type="button"
          onClick={flow.onSkip}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-amber-200/80 transition-colors hover:bg-amber-500/15 hover:text-amber-100"
        >
          <SkipForward className="size-3.5" /> Skip
        </button>
      </div>
    </div>
  );
}
