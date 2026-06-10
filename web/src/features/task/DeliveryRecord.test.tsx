import type { TaskGitContext } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveryRecord } from "./DeliveryRecord";

const ctx = (over: Partial<TaskGitContext> = {}): TaskGitContext => ({
  kind: "branch",
  branch: "cadence/fix-auth-3f2a1b9c",
  baseBranch: "main",
  deliveryCommit: "abc123",
  merged: "merged",
  mergedVia: "cadence",
  checkedAt: 1,
  ...over,
});

function render(gitContext: TaskGitContext | null, delivery?: unknown) {
  const qc = new QueryClient();
  if (delivery !== undefined) qc.setQueryData(["task", "t1", "delivery"], delivery);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <DeliveryRecord taskId="t1" gitContext={gitContext} />
    </QueryClientProvider>,
  );
}

test("done task shows its delivery record: summary, branch, git outcome", () => {
  const html = render(ctx(), {
    mode: "branch_summary",
    summary: "Refreshed tokens before expiry.",
    branch: "cadence/fix-auth-3f2a1b9c",
    prUrl: "https://github.com/o/r/pull/5",
  });
  expect(html).toContain("Delivered");
  expect(html).toContain("cadence/fix-auth-3f2a1b9c");
  expect(html).toContain("Merged into main via Cadence");
  expect(html).toContain("Refreshed tokens before expiry.");
  expect(html).toContain("Open PR/MR ↗");
  expect(html).toContain("border-emerald-500/30"); // shipped = green record
});

test("a done-but-unmerged task gets the amber treatment, not a celebration", () => {
  const html = render(ctx({ merged: "unmerged", mergedVia: null }), {
    mode: "branch_summary",
    summary: "Done but never merged.",
    branch: "cadence/fix-auth-3f2a1b9c",
    prUrl: null,
  });
  expect(html).toContain("Not merged yet");
  expect(html).toContain("border-amber-500/40");
});

test("nothing delivered → renders nothing, not an empty husk", () => {
  expect(render(null, null)).toBe("");
});
