import type { TaskGitContext } from "@cadence/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Board, GitChip, PriorityBadge, ProjectFilter } from "./Board";

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
    forgeOverride: null,
    defaultModel: null,
    defaultPermissionMode: "auto",
    defaultDeliveryMode: "branch_summary",
    autonomy: null,
    worktreesEnabled: false,
    worktreeCheck: null,
    worktreeCheckRun: null,
    systemPrompt: null,
    agentPrompts: null,
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

const gitCtx = (over: Partial<TaskGitContext> = {}): TaskGitContext => ({
  kind: "branch",
  branch: "cadence/fix-auth-3f2a1b9c",
  baseBranch: "main",
  deliveryCommit: "abc123",
  merged: "unmerged",
  mergedVia: null,
  checkedAt: 1,
  ...over,
});

test("GitChip: merged work is green and names the base branch", () => {
  const html = renderToStaticMarkup(
    <GitChip ctx={gitCtx({ merged: "merged", mergedVia: "external" })} status="done" />,
  );
  expect(html).toContain("Merged → main");
  expect(html).toContain("text-emerald-400"); // shipped = green
  expect(html).toContain("cadence/fix-auth-3f2a1b9c"); // full branch in the tooltip
});

test("GitChip: a done task that never merged is the amber honest alarm", () => {
  const html = renderToStaticMarkup(<GitChip ctx={gitCtx()} status="done" />);
  expect(html).toContain("Not merged");
  expect(html).toContain("text-amber-400"); // waiting on you = amber
});

test("GitChip: unmerged-in-review is the expected state — no chip", () => {
  expect(renderToStaticMarkup(<GitChip ctx={gitCtx()} status="review" />)).toBe("");
});

test("GitChip: direct commits show the target branch quietly; gone branches say so", () => {
  const direct = renderToStaticMarkup(
    <GitChip ctx={gitCtx({ kind: "direct", branch: null })} status="done" />,
  );
  expect(direct).toContain("→ main");
  expect(direct).toContain("Committed directly to main"); // plain language in the tooltip

  const gone = renderToStaticMarkup(<GitChip ctx={gitCtx({ merged: "branch_gone" })} status="done" />);
  expect(gone).toContain("Branch gone");
  expect(gone).toContain("possibly squash-merged");
});

test("Board cards show the git chip on done cards", () => {
  const qc = new QueryClient();
  qc.setQueryData(["tasks", "all", "urgency"], [
    {
      id: "t1",
      title: "Fix auth token refresh",
      body: "",
      status: "done",
      priority: null,
      projectId: null,
      fleetId: null,
      deadline: null,
      estimate: null,
      deliveryMode: null,
      permissionMode: null,
      prUrl: null,
      gitContext: gitCtx({ merged: "merged", mergedVia: "cadence" }),
      taskType: "standard",
      reviewDirection: null,
      reviewRef: null,
      parentTaskId: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Merged → main");
});

test("Board has the type filter and review cards carry the Review badge (§6.5.g)", () => {
  const qc = new QueryClient();
  qc.setQueryData(["tasks", "all", "urgency"], [
    {
      id: "r1",
      title: "Review the widget PR",
      body: "",
      status: "ready",
      priority: null,
      projectId: null,
      fleetId: null,
      deadline: null,
      estimate: null,
      deliveryMode: null,
      permissionMode: null,
      prUrl: null,
      taskType: "code_review",
      reviewDirection: "perform",
      reviewRef: "https://github.com/acme/widget/pull/1",
      parentTaskId: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Board onOpen={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain("Reviews"); // the segmented type filter
  expect(html).toContain("⇄ Review"); // the card badge
  expect(html).toContain("reviewing their PR/MR"); // direction-aware tooltip
});
