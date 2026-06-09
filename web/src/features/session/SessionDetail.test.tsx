import type { SessionDetail as SessionDetailT } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionDetail } from "./SessionDetail";

const ID = "abcdef12-0000-0000-0000-000000000000";

function seeded(overrides: Partial<SessionDetailT> = {}): QueryClient {
  const qc = new QueryClient();
  const detail: SessionDetailT = {
    id: ID,
    taskId: null,
    projectId: null,
    fleetId: null,
    role: "chat",
    kind: "warm",
    status: "running",
    cwd: "/tmp/demo",
    branch: null,
    worktreePath: null,
    pid: 4242,
    model: null,
    permissionMode: "auto",
    costUsd: 0.0123,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    transcriptPath: null,
    isLive: true,
    canChat: true,
    ...overrides,
  };
  qc.setQueryData(["session", ID], detail);
  qc.setQueryData(["tasks"], []);
  qc.setQueryData(["projects"], []);
  qc.setQueryData(["fleets"], []);
  qc.setQueryData(["transcript", ID], []);
  return qc;
}

function render(qc: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SessionDetail sessionId={ID} onClose={() => {}} onContinue={() => {}} onOpenTask={() => {}} />
    </QueryClientProvider>,
  );
}

test("SessionDetail shows details, organization, output and live controls", () => {
  const html = render(seeded());
  expect(html).toContain("Session ·");
  expect(html).toContain("abcdef12"); // short id
  expect(html).toContain("$0.0123"); // cost
  expect(html).toContain("4242"); // pid
  expect(html).toContain("Organization");
  expect(html).toContain("Output");
  // a live session can be continued / stopped / killed / deleted
  expect(html).toContain("Continue chat");
  expect(html).toContain("Stop");
  expect(html).toContain("Kill");
  expect(html).toContain("Delete");
  // honest live state: streaming, take-over handoff — never a resume that would fork
  expect(html).toContain("streams below in real time");
  expect(html).toContain("Take over in terminal");
  expect(html).not.toContain("This session has ended");
});

test("SessionDetail streams a live background run without offering chat", () => {
  // a one-shot pipeline run: process alive, but no warm stdin handle
  const html = render(seeded({ kind: "oneshot", role: "implementer", canChat: false }));
  expect(html).not.toContain("Continue chat");
  expect(html).toContain("Stop");
  expect(html).toContain("Kill");
  expect(html).toContain("Take over in terminal");
  expect(html).toContain("streams below in real time");
});

test("SessionDetail hides live-only controls when the process has ended", () => {
  const html = render(
    seeded({ isLive: false, canChat: false, status: "done", endedAt: 1_700_000_300_000 }),
  );
  expect(html).not.toContain("Continue chat");
  expect(html).not.toContain("Kill");
  expect(html).toContain("Open in terminal"); // resume path is still offered
  expect(html).toContain("Copy command");
  expect(html).toContain("This session has ended");
  expect(html).toContain("Delete");
});

test("SessionDetail flags a running-but-unresponsive process instead of lying", () => {
  const html = render(seeded({ isLive: false, canChat: false, status: "running" }));
  expect(html).toContain("isn’t responding");
  expect(html).not.toContain("This session has ended");
});
