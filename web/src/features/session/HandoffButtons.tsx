import { Check, Copy, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { buildResumeCommand, openTerminal } from "../../lib/api";

/**
 * Terminal handoff with honest semantics:
 *  - ended session  → Copy command / Open in terminal (`claude --resume`).
 *  - live session   → Take over in terminal: stops the background run FIRST, then
 *    resumes it interactively. Resuming while it still runs would fork a frozen
 *    copy in the terminal while the background process keeps writing — never offered.
 */
export function HandoffButtons({
  sessionId,
  cwd,
  live = false,
  size = "sm",
}: {
  sessionId: string;
  cwd: string;
  /** The underlying process is still alive (drives take-over vs. resume). */
  live?: boolean;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildResumeCommand(cwd, sessionId));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const open = async (takeover: boolean) => {
    setOpening(true);
    setError(null);
    try {
      await openTerminal(sessionId, { takeover });
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {live && confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
          <span className="text-xs text-amber-300">
            Stop the background run, then resume it in the terminal?
          </span>
          <LabeledIconButton
            icon={<ExternalLink />}
            label={opening ? "Taking over…" : "Take over"}
            size="sm"
            onClick={() => open(true)}
            disabled={opening}
          />
          <LabeledIconButton
            icon={<X />}
            label="Cancel"
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
          />
        </div>
      ) : live ? (
        <LabeledIconButton
          icon={<ExternalLink />}
          label="Take over in terminal"
          variant="outline"
          size={size}
          onClick={() => setConfirming(true)}
          disabled={opening}
        />
      ) : (
        <div className="flex gap-2">
          <LabeledIconButton
            icon={copied ? <Check /> : <Copy />}
            label={copied ? "Copied" : "Copy command"}
            variant="secondary"
            size={size}
            onClick={copy}
          />
          <LabeledIconButton
            icon={<ExternalLink />}
            label="Open in terminal"
            variant="outline"
            size={size}
            onClick={() => open(false)}
            disabled={opening}
          />
        </div>
      )}
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
