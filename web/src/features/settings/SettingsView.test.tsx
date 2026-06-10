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

test("SettingsView has section navigation incl. Agents & Prompts (§6.3.c)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SettingsView />
    </QueryClientProvider>,
  );
  expect(html).toContain("General");
  expect(html).toContain("Agents &amp; Prompts");
  // the global-vs-per-agent distinction is explained inline (clarity over confusion)
  expect(html).toContain("context layer");
});

test("SettingsView nav includes the Formats section (§6.3.d)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SettingsView />
    </QueryClientProvider>,
  );
  expect(html).toContain("Formats");
});

test("SettingsView nav includes the Operations section (§6.3.e)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SettingsView />
    </QueryClientProvider>,
  );
  expect(html).toContain("Operations");
});

test("SettingsView nav includes the Code review section (§6.5.h)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SettingsView />
    </QueryClientProvider>,
  );
  expect(html).toContain("Code review");
});
