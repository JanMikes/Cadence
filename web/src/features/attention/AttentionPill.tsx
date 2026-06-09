import { AlertTriangle, Check, ShieldQuestion } from "lucide-react";
import { cn } from "../../lib/utils";
import { ATTENTION_SHORTCUT } from "../../lib/shortcuts";
import { useAttention } from "./useAttention";

/**
 * The always-visible global indicator (top bar): "N need you". Muted when nothing is
 * waiting, amber when something is, and red+pulsing when a live agent is blocked on a
 * tool approval. Clicking opens the Attention Center. Labeled per the UX rules (§10.1).
 */
export function AttentionPill({ onOpen }: { onOpen: () => void }) {
  const attention = useAttention();
  const items = attention.data?.items ?? [];
  const count = items.length;
  const hasTool = items.some((i) => i.kind === "tool_approval");

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Needs you (${ATTENTION_SHORTCUT.label})`}
      aria-label={`${count ? `${count} item${count === 1 ? "" : "s"} need you` : "Nothing needs you"} (${ATTENTION_SHORTCUT.label})`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        count === 0 && "border-border text-muted-foreground hover:bg-accent",
        count > 0 && !hasTool && "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
        hasTool && "animate-pulse border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20",
      )}
    >
      {count === 0 ? (
        <Check className="size-3.5" />
      ) : hasTool ? (
        <ShieldQuestion className="size-3.5" />
      ) : (
        <AlertTriangle className="size-3.5" />
      )}
      {count > 0 ? `${count} need${count === 1 ? "s" : ""} you` : "All clear"}
      <kbd className="ml-0.5 rounded border border-current/40 px-1 font-sans text-[10px] font-medium leading-tight opacity-60">
        {ATTENTION_SHORTCUT.label}
      </kbd>
    </button>
  );
}
