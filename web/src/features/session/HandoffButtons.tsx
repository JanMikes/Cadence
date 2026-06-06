import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { buildResumeCommand, openTerminal } from "../../lib/api";

/** Terminal handoff: copy the resume command, or open it in the preferred terminal. */
export function HandoffButtons({
  sessionId,
  cwd,
  size = "sm",
}: {
  sessionId: string;
  cwd: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildResumeCommand(cwd, sessionId));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const open = async () => {
    setOpening(true);
    try {
      await openTerminal(sessionId);
    } catch {
      /* surfaced elsewhere */
    } finally {
      setOpening(false);
    }
  };

  return (
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
        onClick={open}
        disabled={opening}
      />
    </div>
  );
}
