import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AddTaskButton, AddTaskModal } from "./AddTaskModal";

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
  expect(html).toContain("Lands in your Inbox");
  expect(html).toContain("<textarea"); // description
  expect(html).toContain("<input"); // optional title
  // The description textarea comes first (it's the default field).
  expect(html.indexOf("<textarea")).toBeLessThan(html.indexOf('aria-label="Title (optional)"'));
});

test("AddTaskButton is labeled (icon + text) and shows the C shortcut hint", () => {
  const html = renderToStaticMarkup(<AddTaskButton onClick={() => {}} />);
  expect(html).toContain("Add task");
  expect(html).toContain("<kbd");
  expect(html).toContain(">C<");
});
