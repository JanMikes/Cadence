import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { getTasks } from "../../lib/api";
import { MONTH_NAMES, WEEKDAY_LABELS, dayKey, monthGrid, tasksByDay } from "../../lib/calendar";
import { cn } from "../../lib/utils";

const TIER_DOT: Record<string, string> = {
  overdue: "bg-red-500/20 text-red-300",
  due_soon: "bg-amber-500/20 text-amber-300",
};

/**
 * Calendar / deadline view (spec §10, Principle 12): a month grid placing each
 * task on its deadline day. Click a task to open it; today is highlighted.
 */
export function Calendar({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  const tasks = useQuery({ queryKey: ["tasks", "all"], queryFn: () => getTasks() });
  const byDay = tasksByDay(tasks.data ?? []);
  const grid = monthGrid(year, month);
  const todayKey = dayKey(today);

  const shift = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  return (
    <div className="flex h-full flex-col p-6">
      <div className="flex items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CalendarDays className="size-5" /> Calendar
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => shift(-1)}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="w-40 text-center text-sm font-medium">
            {MONTH_NAMES[month]} {year}
          </span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => shift(1)}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-7 gap-px text-xs text-muted-foreground">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="px-2 py-1 font-medium">
            {d}
          </div>
        ))}
      </div>
      <div className="mt-px grid flex-1 grid-cols-7 gap-px overflow-auto rounded-lg border border-border bg-border">
        {grid.flat().map((cell) => {
          const dayTasks = byDay.get(cell.key) ?? [];
          const isToday = cell.key === todayKey;
          return (
            <div
              key={cell.key}
              className={cn(
                "min-h-[5.5rem] bg-background p-1.5",
                !cell.inMonth && "bg-background/40 text-muted-foreground",
              )}
            >
              <div
                className={cn(
                  "mb-1 inline-flex size-5 items-center justify-center rounded-full text-[11px]",
                  isToday ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {cell.date.getDate()}
              </div>
              <div className="flex flex-col gap-0.5">
                {dayTasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onOpenTask(t.id)}
                    title={t.title}
                    className={cn(
                      "truncate rounded px-1 py-0.5 text-left text-[11px] hover:opacity-80",
                      TIER_DOT[t.urgencyTier ?? ""] ?? "bg-muted text-foreground/80",
                    )}
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
