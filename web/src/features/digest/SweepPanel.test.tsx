import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SweepPanel } from "./SweepPanel";

function render(qc: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SweepPanel onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

test("SweepPanel renders nothing until the sweep loads", () => {
  expect(render(new QueryClient())).toBe("");
});

test("SweepPanel shows an explicit all-clear once the sweep ran clean", () => {
  const qc = new QueryClient();
  qc.setQueryData(["sweep"], { findings: [], ranAt: 0 });
  expect(render(qc)).toContain("nothing stale or at deadline risk");
});

test("SweepPanel lists findings when something needs attention", () => {
  const qc = new QueryClient();
  qc.setQueryData(["sweep"], {
    findings: [{ kind: "at_risk", taskId: "t1", title: "Fix the thing", status: "ready", detail: "due in 1d" }],
    ranAt: 0,
  });
  const html = render(qc);
  expect(html).toContain("Needs attention (1)");
  expect(html).toContain("Fix the thing");
});
