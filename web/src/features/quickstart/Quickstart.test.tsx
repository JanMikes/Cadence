import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Quickstart } from "./Quickstart";

const noop = () => {};

test("Quickstart explains the product, the pipeline, and the review flagship", () => {
  const html = renderToStaticMarkup(<Quickstart onNavigate={noop} onAddTask={noop} />);

  // Hero
  expect(html).toContain("Welcome to Cadence");
  expect(html).toContain("Your backlog, in flow.");
  expect(html).toContain("Capture your first task");

  // The pipeline — all six steps, with the who-does-what chips
  expect(html).toContain("How it works");
  for (const step of [
    "Capture",
    "Triage &amp; refine",
    "Questions, only when needed",
    "You press PLAY",
    "Implement &amp; verify",
    "Review &amp; deliver",
  ]) {
    expect(html).toContain(step);
  }
  expect(html).toContain("Cadence — autonomous");
  expect(html).toContain("Propose, don&#x27;t impose.");

  // Flagship: code review for real PRs/MRs, explicit-confirm publishing
  expect(html).toContain("Code review for real pull &amp; merge requests");
  expect(html).toContain("GitHub");
  expect(html).toContain("GitLab");
  expect(html).toContain("Publishes only on your confirm");

  // Guardrails + how to reopen the guide
  expect(html).toContain("Permission modes");
  expect(html).toContain("Local-first");
  expect(html).toContain("at the bottom of the");
  expect(html).toContain("How it works");
});

test("Quickstart feature cards link to the main views by label", () => {
  const html = renderToStaticMarkup(<Quickstart onNavigate={noop} onAddTask={noop} />);
  for (const open of [
    "Open Today",
    "Open Board",
    "Open Sessions",
    "Open Projects",
    "Open Memory",
    "See reviews on the Board",
  ]) {
    expect(html).toContain(open);
  }
});
