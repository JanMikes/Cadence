import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChipSelect } from "./ChipSelect";

const groups = [
  { options: [{ value: "auto", label: "✨ Auto" }] },
  {
    label: "Recent",
    options: [
      { value: "acme", label: "Acme App" },
      { value: "tools", label: "Internal Tools" },
    ],
  },
];

test("ChipSelect renders a labeled pill backed by the autocomplete combobox", () => {
  const html = renderToStaticMarkup(
    <ChipSelect label="Project" value="acme" groups={groups} onChange={() => {}} />,
  );
  expect(html).toContain('aria-label="Project"'); // the input is the accessible control
  expect(html).toContain('role="combobox"'); // type-to-filter, not a native select
  expect(html).toContain("Project:"); // pill prefix
  expect(html).toContain("Acme App"); // pill shows the selected option's label
});

test("ChipSelect display overrides the pill text; active tints the pill", () => {
  const html = renderToStaticMarkup(
    <ChipSelect label="Deadline" value="auto" display="✨ Auto" groups={groups} onChange={() => {}} active />,
  );
  expect(html).toContain("✨ Auto");
  expect(html).toContain("border-primary/40"); // active tint
});
