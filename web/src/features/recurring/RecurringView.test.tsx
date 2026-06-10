import type { RecurringTask } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecurringEditor, RecurringView } from "./RecurringView";

const recurring = (over: Partial<RecurringTask> = {}): RecurringTask => ({
  id: "r1",
  title: "Generate the monthly timesheet",
  body: "Pull the Toggl entries.",
  cadence: "monthly",
  dayOfWeek: null,
  dayOfMonth: 1,
  time: "09:00",
  projectId: null,
  priority: "P2",
  paused: false,
  lastTriggeredAt: null,
  lastTaskId: null,
  nextRunAt: Date.now() + 3 * 3_600_000,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function render(items?: RecurringTask[]): string {
  const qc = new QueryClient();
  if (items) qc.setQueryData(["recurring"], items);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <RecurringView onOpenTask={() => {}} />
    </QueryClientProvider>,
  );
}

test("empty state explains the feature and offers the first-template CTA", () => {
  const html = render([]);
  expect(html).toContain("Recurring tasks");
  expect(html).toContain("No recurring tasks yet");
  expect(html).toContain("Create your first one");
  expect(html).toContain("New recurring task"); // header action is always available
});

test("a card leads with intention: plain-language schedule + concrete next run", () => {
  const html = render([recurring()]);
  expect(html).toContain("Generate the monthly timesheet");
  expect(html).toContain("Monthly on the 1st at 09:00"); // human sentence, not cron
  expect(html).toContain("Next run"); // the concrete timestamp follows
  expect(html).toContain("Run now");
  expect(html).toContain("Pause");
  expect(html).toContain("Edit");
  expect(html).toContain("Delete");
  expect(html).toContain("Never run yet"); // honest history, even when empty
});

test("a paused card says so and shows Resume instead of Pause", () => {
  const html = render([recurring({ paused: true, nextRunAt: null })]);
  expect(html).toContain("Paused");
  expect(html).toContain("Paused — no next run"); // no silent dead end
  expect(html).toContain("Resume");
  expect(html).not.toContain(">Pause<");
});

test("a due card flags that it is about to run instead of showing a past date", () => {
  const html = render([recurring({ nextRunAt: Date.now() - 60_000 })]);
  expect(html).toContain("Due — runs within a moment");
});

test("a card that has run links to the task it created", () => {
  const html = render([recurring({ lastTriggeredAt: Date.now() - 3_600_000, lastTaskId: "t9" })]);
  expect(html).toContain("Last created");
  expect(html).not.toContain("Never run yet");
});

test("the editor previews exactly when the next task will be created", () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RecurringEditor initial={null} projects={[]} onClose={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("New recurring task");
  expect(html).toContain("Daily");
  expect(html).toContain("Weekly");
  expect(html).toContain("Monthly");
  expect(html).toContain("Mon"); // weekly is the default → weekday picker visible
  expect(html).toContain("This becomes the task description on every run.");
  expect(html).toContain("Add a description to schedule it."); // empty form → no fake preview
  expect(html).toContain("Create recurring task");
});

test("editing a monthly template shows the day-of-month picker with the clamping hint for day 31", () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RecurringEditor initial={recurring({ dayOfMonth: 31 })} projects={[]} onClose={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("of every month");
  expect(html).toContain("Months with fewer days run on their last day");
  expect(html).toContain("Save changes");
  // A filled template previews a concrete next occurrence.
  expect(html).toContain("Next task will be created");
});
