import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { filterGroups, SelectBox } from "./SelectBox";

const options = [
  { value: "", label: "Inherit" },
  { value: "branch_summary", label: "Branch + summary", hint: "Leaves the work on a branch." },
  { value: "auto_pr", label: "Auto PR", hint: "Opens a pull request." },
];

test("SelectBox renders an accessible combobox showing the selected label", () => {
  const html = renderToStaticMarkup(
    <SelectBox label="Delivery mode" value="branch_summary" options={options} onChange={() => {}} />,
  );
  expect(html).toContain('role="combobox"'); // type-to-filter, not a native select
  expect(html).toContain('aria-label="Delivery mode"');
  expect(html).toContain("Branch + summary"); // selected label is real markup (first paint)
  expect(html).toContain('aria-label="Show Delivery mode options"'); // labeled chevron trigger
});

test("SelectBox falls back to the placeholder when nothing is selected", () => {
  const html = renderToStaticMarkup(
    <SelectBox label="Blocker" value="" placeholder="+ add blocker…" options={options.slice(1)} onChange={() => {}} />,
  );
  expect(html).toContain("+ add blocker…");
});

test("filterGroups narrows by label (case-insensitive) and drops emptied groups", () => {
  const groups = [
    { label: "Modes", options },
    { label: "Other", options: [{ value: "x", label: "Unrelated" }] },
  ];
  const hit = filterGroups(groups, "branch");
  expect(hit).toHaveLength(1);
  expect(hit[0]!.options.map((o) => o.value)).toEqual(["branch_summary"]);
  expect(filterGroups(groups, "")).toHaveLength(2); // empty query keeps everything
  expect(filterGroups(groups, "zzz")).toHaveLength(0); // no matches → "No matches" row
});
