import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoffButtons } from "../session/HandoffButtons";
import { SettingsView } from "./SettingsView";

test("SettingsView renders the preferred-terminal + global default controls", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SettingsView />
    </QueryClientProvider>,
  );
  expect(html).toContain("Settings");
  expect(html).toContain("Preferred terminal");
  expect(html).toContain("Terminal");
  expect(html).toContain("iTerm");
  expect(html).toContain("Claude binary path");
  expect(html).toContain("Save settings");
});

test("HandoffButtons renders Copy command + Open in terminal", () => {
  const html = renderToStaticMarkup(<HandoffButtons sessionId="abc12345" cwd="/tmp/x" />);
  expect(html).toContain("Copy command");
  expect(html).toContain("Open in terminal");
});
