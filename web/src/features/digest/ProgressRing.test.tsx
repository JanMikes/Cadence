import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressRing } from "./ProgressRing";

test("ProgressRing shows the done/total fraction and an a11y label", () => {
  const html = renderToStaticMarkup(<ProgressRing done={3} total={5} />);
  expect(html).toContain("3/5");
  expect(html).toContain("3 of 5 done");
});

test("ProgressRing turns green when the goal is complete", () => {
  const html = renderToStaticMarkup(<ProgressRing done={4} total={4} />);
  expect(html).toContain("text-green-400");
});
