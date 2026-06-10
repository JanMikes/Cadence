import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "./AppShell";

test("AppShell renders a labeled nudge chip on a nav item", () => {
  const html = renderToStaticMarkup(
    <AppShell
      activeView="board"
      onNavigate={() => {}}
      navAlerts={{
        today: { label: "Plan your day", title: "Today's plan isn't committed yet", tone: "warning" },
      }}
    >
      <div />
    </AppShell>,
  );
  expect(html).toContain("Plan your day");
  expect(html).toContain("Today&#x27;s plan isn&#x27;t committed yet");
});

test("AppShell numeric badge wins over an alert chip on the same item", () => {
  const html = renderToStaticMarkup(
    <AppShell
      activeView="board"
      onNavigate={() => {}}
      navBadges={{ today: 3 }}
      navAlerts={{ today: { label: "Plan your day" } }}
    >
      <div />
    </AppShell>,
  );
  expect(html).not.toContain("Plan your day");
});
