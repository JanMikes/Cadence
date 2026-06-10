import { expect, test } from "bun:test";
import { Plus } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "./AppShell";
import { LabeledIconButton } from "./LabeledIconButton";

test("LabeledIconButton renders an icon AND a text label (never icon-only)", () => {
  const html = renderToStaticMarkup(<LabeledIconButton icon={<Plus />} label="New task" />);
  expect(html).toContain("New task"); // the required label
  expect(html).toContain("<svg"); // the icon
  expect(html).toContain("<button");
});

test("AppShell renders the themed shell with a labeled left-nav + content", () => {
  const html = renderToStaticMarkup(
    <AppShell status="ok" activeView="board" onNavigate={() => {}}>
      <div>main-content-here</div>
    </AppShell>,
  );
  expect(html).toContain("Cadence");
  expect(html).not.toContain("Inbox"); // the Inbox view was removed in 6.2
  expect(html).toContain("Board");
  expect(html).toContain("Settings");
  expect(html).toContain("main-content-here");
  // Theme utility classes are applied (dark dev theme).
  expect(html).toContain("bg-background");
});
