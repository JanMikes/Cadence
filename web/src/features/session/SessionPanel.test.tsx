import type { SessionDetail, TranscriptEntry } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPanel } from "./SessionPanel";

const ID = "abcdef12-0000-0000-0000-000000000000";

function seeded(detail: Partial<SessionDetail> = {}, transcript: TranscriptEntry[] = []): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(["session", ID], {
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
    costUsd: 0,
    startedAt: 1,
    endedAt: null,
    transcriptPath: null,
    isLive: true,
    canChat: true,
    ...detail,
  } satisfies SessionDetail);
  qc.setQueryData(["transcript", ID], transcript);
  return qc;
}

function render(qc: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SessionPanel sessionId={ID} onClose={() => {}} onOpenDetail={() => {}} />
    </QueryClientProvider>,
  );
}

test("a live session shows the chat header, placeholder and follow-up input", () => {
  const html = render(seeded());
  expect(html).toContain("Claude session");
  expect(html).toContain("abcdef12"); // short id
  expect(html).toContain("Session started — send a message below.");
  expect(html).toContain("Send a follow-up");
});

test("an ended session is honest: no input, an ended notice + path to details", () => {
  const html = render(seeded({ status: "done", isLive: false, canChat: false, endedAt: 2 }));
  expect(html).toContain("This session has ended");
  expect(html).not.toContain("Send a follow-up");
  expect(html).not.toContain("Session started — send a message below.");
  expect(html).toContain("Session details"); // the way forward (resume/terminal handoff)
  expect(html).toContain("ended (done)");
});
