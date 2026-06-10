import type { UsageResponse } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarUsage } from "./UsageBar";

function render(data?: UsageResponse): string {
  const qc = new QueryClient();
  if (data) qc.setQueryData(["usage"], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SidebarUsage />
    </QueryClientProvider>,
  );
}

const STATS = {
  totalSessions: 0,
  totalMessages: 0,
  lastComputedDate: null,
  recentDay: null,
  week: { messages: 0, sessions: 0, tokens: 0 },
  topModels: [],
};

test("SidebarUsage renders nothing until usage data loads (no crash without provider data)", () => {
  expect(render()).toBe("");
});

test("SidebarUsage shows 5h + weekly meters with percentages and reset countdowns", () => {
  const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString();
  const html = render({
    stats: STATS,
    rateLimit: null,
    windows: {
      fiveHour: { utilization: 40, resetsAt: inTwoHours },
      sevenDay: { utilization: 92, resetsAt: inTwoHours },
      sevenDayOpus: null,
      fetchedAt: Date.now(),
    },
  });
  expect(html).toContain("Claude usage");
  expect(html).toContain("Session (5h)");
  expect(html).toContain("Week");
  expect(html).toContain("40%");
  expect(html).toContain("92%");
  expect(html).toContain("resets in");
  // the near-limit weekly meter goes red
  expect(html).toContain("bg-red-400");
  // the old all-time noise is gone
  expect(html).not.toContain("sessions all-time");
});

test("SidebarUsage explains itself when windows are unavailable", () => {
  const html = render({ stats: STATS, rateLimit: null, windows: null });
  expect(html).toContain("usage windows unavailable");
});
