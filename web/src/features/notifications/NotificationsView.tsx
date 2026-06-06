import { Bell, BellRing, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { cn } from "../../lib/utils";
import { ProposalsPanel } from "./ProposalsPanel";
import { markAllRead, useNotifications } from "./store";

const KIND_LABEL: Record<string, string> = {
  needs_feedback: "Needs your input",
  delivered: "Delivered",
  info: "Info",
};

export function NotificationsView({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const items = useNotifications();
  const [perm, setPerm] = useState<string>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  // Viewing the list clears the unread badge.
  useEffect(() => {
    markAllRead();
  }, []);

  const requestPermission = async () => {
    if (typeof Notification === "undefined") return;
    setPerm(await Notification.requestPermission());
  };

  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        {perm !== "granted" ? (
          <LabeledIconButton
            icon={<BellRing />}
            label="Enable desktop alerts"
            variant="secondary"
            size="sm"
            onClick={requestPermission}
          />
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="size-3.5" /> Desktop alerts on
          </span>
        )}
      </div>

      <ProposalsPanel />

      <ul className="mt-6 flex flex-col gap-2">
        {items.length === 0 ? (
          <li className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            <Bell className="mx-auto mb-2 size-5" />
            Nothing yet. You’ll be alerted when a task needs your input or is delivered.
          </li>
        ) : null}
        {items.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              disabled={!n.taskId}
              onClick={() => n.taskId && onOpenTask(n.taskId)}
              className={cn(
                "flex w-full items-start gap-3 rounded-md border border-border bg-card/50 px-4 py-3 text-left transition-colors",
                n.taskId && "hover:border-primary/50",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 size-2 shrink-0 rounded-full",
                  n.kind === "needs_feedback" ? "bg-yellow-500" : "bg-green-500",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{n.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{n.body}</span>
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {KIND_LABEL[n.kind] ?? n.kind}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
