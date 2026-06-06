import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationsView } from "./NotificationsView";

test("NotificationsView renders the empty state + a desktop-alerts control", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <NotificationsView onOpenTask={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Notifications");
  // empty state (no notifications in SSR)
  expect(html).toContain("Nothing yet");
  // a way to enable OS notifications (Notification undefined in SSR -> permission "denied")
  expect(html).toContain("Enable desktop alerts");
});
