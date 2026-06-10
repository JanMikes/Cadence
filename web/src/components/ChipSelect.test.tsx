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

test("ChipSelect renders a labeled pill backed by a real native select", () => {
  const html = renderToStaticMarkup(
    <ChipSelect label="Project" value="acme" groups={groups} onChange={() => {}} />,
  );
  expect(html).toContain('aria-label="Project"'); // the select is the accessible control
  expect(html).toContain("<select");
  expect(html).toContain('<optgroup label="Recent">');
  expect(html).toContain('<option value="acme" selected="">Acme App</option>');
  expect(html).toContain("Acme App"); // pill shows the selected option's label
});

test("ChipSelect display overrides the pill text; active tints the pill", () => {
  const html = renderToStaticMarkup(
    <ChipSelect label="Deadline" value="auto" display="✨ Auto" groups={groups} onChange={() => {}} active />,
  );
  expect(html).toContain("✨ Auto");
  expect(html).toContain("border-primary/40"); // active tint
});
