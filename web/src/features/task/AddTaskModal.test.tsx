import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AddTaskButton, AddTaskModal, deadlineChipMs } from "./AddTaskModal";

function render(node: React.ReactNode) {
  const qc = new QueryClient();
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

test("AddTaskModal renders nothing while closed", () => {
  const html = render(<AddTaskModal open={false} onOpenChange={() => {}} />);
  expect(html).toBe(""); // opened via the sidebar button, the ⌘K palette, or the `c` shortcut
});

test("AddTaskModal is description-first: required description + optional title", () => {
  const html = render(<AddTaskModal open onOpenChange={() => {}} />);
  expect(html).toContain("Add task");
  expect(html).toContain("Describe the task"); // the primary capture field
  expect(html).toContain("Title (optional"); // auto-named by the refinement agent when left empty
  expect(html).toContain("Chips on Auto are decided during refinement");
  expect(html).toContain("<textarea"); // description
  expect(html).toContain("<input"); // optional title
});

test("AddTaskModal capture chips default to Auto/Inherit (nothing pinned)", () => {
  const html = render(<AddTaskModal open onOpenChange={() => {}} />);
  // Each chip is a labeled native select (keyboard-first, §10.1: always a text label).
  expect(html).toContain('aria-label="Project"');
  expect(html).toContain('aria-label="Deadline"');
  expect(html).toContain('aria-label="Priority"');
  expect(html).toContain('aria-label="Permissions"');
  expect(html).toContain("✨ Auto"); // project + deadline + priority default
  expect(html).toContain("Inherit (project default)"); // permission default
  // Priority options are human-readable — P0..P3 alone is ambiguous.
  expect(html).toContain("Critical (P0)");
  expect(html).toContain("Low (P3)");
});

test("deadlineChipMs resolves chips to local end-of-day epochs", () => {
  const now = new Date(2026, 5, 10, 9, 30); // Wed 2026-06-10
  expect(deadlineChipMs("today", "", now)).toBe(new Date(2026, 5, 10, 23, 59, 59).getTime());
  expect(deadlineChipMs("tomorrow", "", now)).toBe(new Date(2026, 5, 11, 23, 59, 59).getTime());
  // "This week" = the upcoming Sunday.
  expect(deadlineChipMs("week", "", now)).toBe(new Date(2026, 5, 14, 23, 59, 59).getTime());
  expect(deadlineChipMs("date", "2026-07-01", now)).toBe(new Date(2026, 6, 1, 23, 59, 59).getTime());
  expect(deadlineChipMs("date", "garbage", now)).toBeNull();
  expect(deadlineChipMs("none", "", now)).toBeNull(); // explicit "no deadline"
});

test("AddTaskButton is labeled (icon + text) and shows the C shortcut hint", () => {
  const html = renderToStaticMarkup(<AddTaskButton onClick={() => {}} />);
  expect(html).toContain("Add task");
  expect(html).toContain("<kbd");
  expect(html).toContain(">C<");
});
