import type { LockBlocker } from "@cadence/shared";
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { _resetActivity, _setActivity } from "../../lib/activity";
import { QueuedBanner } from "./QueuedBanner";

afterEach(() => {
  _resetActivity();
});

function render(): string {
  return renderToStaticMarkup(
    <QueuedBanner taskId="t1" onOpenTask={() => {}} onOpenSessionDetail={() => {}} />,
  );
}

test("renders nothing unless the task is verifiably queued", () => {
  expect(render()).toBe("");
  _setActivity("t1", "implementer");
  expect(render()).toBe("");
});

test("a queued task says WHY: who occupies the folder, with deep-link actions", () => {
  const blockers: LockBlocker[] = [
    {
      kind: "execution",
      label: "the task “Fix login” (implementer)",
      taskId: "t-blocker",
      sessionId: "s-blocker",
    },
  ];
  _setActivity("t1", "queued", "the task “Fix login” (implementer)", blockers);
  const html = render();
  expect(html).toContain("Queued — the project folder is busy");
  expect(html).toContain("Cadence task");
  expect(html).toContain("the task “Fix login” (implementer)");
  expect(html).toContain("Open task");
  expect(html).toContain("View session");
  // a Cadence-internal blocker never shows the "your own session" advice
  expect(html).not.toContain("Waiting on your own session?");
});

test("an EXTERNAL blocker is named as the user's own session, with the worktrees tip", () => {
  const blockers: LockBlocker[] = [
    {
      kind: "external",
      label: "a Claude Code session outside Cadence (pid 777, /tmp/p)",
      pid: 777,
      cwd: "/tmp/p",
      sessionId: "ext-1",
    },
  ];
  _setActivity("t1", "queued", "a Claude Code session outside Cadence (pid 777, /tmp/p)", blockers);
  const html = render();
  expect(html).toContain("Your Claude session");
  expect(html).toContain("View session"); // opens the read-only session drawer
  expect(html).toContain("Waiting on your own session?");
  expect(html).toContain("worktrees");
});

test("older label-only payloads (no structured blockers) still explain the wait", () => {
  _setActivity("t1", "queued", "the task “Fix login” (implementer)");
  const html = render();
  expect(html).toContain("Queued — the project folder is busy");
  expect(html).toContain("Waiting for the task “Fix login” (implementer)");
});
