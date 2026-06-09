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

test("AddTaskModal shows title + notes fields and a labeled Add task button when open", () => {
  const html = render(<AddTaskModal open onOpenChange={() => {}} />);
  expect(html).toContain("Add task");
  expect(html).toContain("Task title");
  expect(html).toContain("Notes (optional)");
  expect(html).toContain("Lands in your Inbox");
  expect(html).toContain("<input");
  expect(html).toContain("<textarea");
});

test("AddTaskButton is labeled (icon + text) and shows the C shortcut hint", () => {
  const html = renderToStaticMarkup(<AddTaskButton onClick={() => {}} />);
  expect(html).toContain("Add task");
  expect(html).toContain("<kbd");
  expect(html).toContain(">C<");
});
