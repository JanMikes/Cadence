import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Board, PriorityBadge, ProjectFilter } from "./Board";

test("Board renders lifecycle columns with plain-language labels", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Board");
  expect(html).toContain("Inbox");
  expect(html).toContain("Ready");
  expect(html).toContain("Needs input"); // plain language for needs_feedback
  expect(html).toContain("Plan review"); // waiting-for-you ≠ actively working (plan_review)
  expect(html).toContain("In progress"); // plain language for implementing
  expect(html).toContain("Done");
});

test("Board columns carry semantic accent colors (border-top by meaning)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("border-t-2"); // every column gets a colored top edge…
  expect(html).toContain("border-t-zinc-400/80"); // inbox: raw
  expect(html).toContain("border-t-amber-400/80"); // needs_feedback: waiting on you
  expect(html).toContain("border-t-violet-400/80"); // plan_review: waiting on you
  expect(html).toContain("border-t-rose-400/80"); // review: waiting on you
  expect(html).toContain("border-t-green-400/80"); // ready: go (matches PLAY)
  expect(html).toContain("border-t-emerald-400/80"); // done: shipped
  expect(html).toContain("border-t-blue-400/80"); // implementing: Cadence working
});

test("Board shows the project filter as a dropdown, closed by default (All projects)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Projects:");
  expect(html).toContain("All projects"); // nothing checked (initial state) = show everything
  expect(html).not.toContain("No project"); // options live inside the (closed) dropdown
  expect(html).not.toContain(">Clear<"); // Clear only appears once a filter is active
});

const PROJECTS = [
  {
    id: "p1",
    name: "Acme",
    slug: "acme",
    color: "#ff0000",
    rootPath: null,
    gitRemote: null,
    defaultModel: null,
    defaultPermissionMode: "auto",
    defaultDeliveryMode: "branch_summary",
    autonomy: null,
    systemPrompt: null,
    notes: null,
    createdAt: 0,
  },
];

test("ProjectFilter dropdown lists checkboxes per project + No project + Clear", () => {
  const html = renderToStaticMarkup(
    <ProjectFilter
      projects={PROJECTS}
      selected={new Set(["p1"])}
      onToggle={() => {}}
      onClear={() => {}}
      shown={3}
      total={10}
      defaultOpen
    />,
  );
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("Acme");
  expect(html).toContain("No project"); // tasks without a project are filterable too
  expect(html).toContain("Clear — show all projects");
  expect(html).toContain("3 of 10 tasks"); // filtering shows its effect
  expect(html).toContain(">Clear<"); // the small inline Clear next to the trigger
});

test("PriorityBadge renders Jira-style arrows + colors (and falls back to raw text)", () => {
  const p0 = renderToStaticMarkup(<PriorityBadge priority="P0" />);
  expect(p0).toContain("text-red-400"); // highest: red double-up
  expect(p0).toContain("Priority: Highest (P0)");
  expect(p0).not.toContain(">P0<"); // the cryptic code is gone, the tooltip explains

  const p1 = renderToStaticMarkup(<PriorityBadge priority="P1" />);
  expect(p1).toContain("text-orange-400");

  const p2 = renderToStaticMarkup(<PriorityBadge priority="P2" />);
  expect(p2).toContain("text-amber-300");

  const p3 = renderToStaticMarkup(<PriorityBadge priority="p3" />);
  expect(p3).toContain("text-sky-400");

  const alias = renderToStaticMarkup(<PriorityBadge priority="high" />);
  expect(alias).toContain("text-orange-400"); // free-text aliases map onto the scale

  const raw = renderToStaticMarkup(<PriorityBadge priority="someday" />);
  expect(raw).toContain("someday"); // unknown values stay visible as-is
});
