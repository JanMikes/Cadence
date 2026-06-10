import { expect, test } from "bun:test";
import { DEFAULT_FORMATS, formatTimestamp, SYSTEM_FORMAT } from "./datetime";

// 2026-06-10 14:05:09 local time — the plan's verify example.
const T = new Date(2026, 5, 10, 14, 5, 9);

test("Czech default renders 10.06.2026 14:05:09 (§6.3.d verify)", () => {
  expect(formatTimestamp(T, DEFAULT_FORMATS.dateTime)).toBe("10.06.2026 14:05:09");
  expect(formatTimestamp(T, DEFAULT_FORMATS.date, "date")).toBe("10.06.2026");
});

test("token coverage: padded vs plain, 2-digit year, passthrough separators", () => {
  expect(formatTimestamp(T, "Y-m-d H:i")).toBe("2026-06-10 14:05");
  expect(formatTimestamp(T, "n/j/y")).toBe("6/10/26");
  expect(formatTimestamp(new Date(2026, 5, 3, 7, 4, 2), "j.n.Y G:i:s")).toBe("3.6.2026 7:04:02");
  expect(formatTimestamp(T, "d. m. Y")).toBe("10. 06. 2026"); // literal dots + spaces pass through
});

test("null/invalid timestamps render an em dash, numbers work like Dates", () => {
  expect(formatTimestamp(null, "d.m.Y")).toBe("—");
  expect(formatTimestamp(undefined, "d.m.Y")).toBe("—");
  expect(formatTimestamp(Number.NaN, "d.m.Y")).toBe("—");
  expect(formatTimestamp(T.getTime(), "d.m.Y")).toBe("10.06.2026");
});

test("SYSTEM sentinel defers to the locale (smoke: non-empty, no tokens)", () => {
  const out = formatTimestamp(T, SYSTEM_FORMAT);
  expect(out.length).toBeGreaterThan(0);
  expect(out).not.toContain("SYSTEM");
});
