import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { LabeledIconButton } from "./LabeledIconButton";

/**
 * Shared centered modal: backdrop click + Esc + the labeled Close button all dismiss.
 * Header stays pinned; the body scrolls, so long content never pushes Close off-screen.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (handler above); backdrop is a convenience
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[8vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
            {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
          <LabeledIconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
