import { expect, test } from "bun:test";
import { DEFAULT_VIEW, formatHash, parseHash } from "./hashRoute";

test("parseHash restores a plain view, with or without the leading #", () => {
  expect(parseHash("#board")).toEqual({ view: "board", taskId: null });
  expect(parseHash("board")).toEqual({ view: "board", taskId: null });
  expect(parseHash("#settings")).toEqual({ view: "settings", taskId: null });
});

test("parseHash restores view + open task from `?task=`", () => {
  expect(parseHash("#board?task=f7ee1f05-2bf2-4399-8676-04cffca4bf75")).toEqual({
    view: "board",
    taskId: "f7ee1f05-2bf2-4399-8676-04cffca4bf75",
  });
});

test("parseHash falls back to the default view on empty or unknown hashes", () => {
  expect(parseHash("")).toEqual({ view: DEFAULT_VIEW, taskId: null });
  expect(parseHash("#")).toEqual({ view: DEFAULT_VIEW, taskId: null });
  expect(parseHash("#nonsense")).toEqual({ view: DEFAULT_VIEW, taskId: null });
  expect(parseHash("#/board")).toEqual({ view: DEFAULT_VIEW, taskId: null });
});

test("parseHash drops the task param when the view is unrecognized", () => {
  expect(parseHash("#bogus?task=abc")).toEqual({ view: DEFAULT_VIEW, taskId: null });
  expect(parseHash("#?task=abc")).toEqual({ view: DEFAULT_VIEW, taskId: null });
});

test("formatHash mirrors parseHash (round-trip)", () => {
  for (const route of [
    { view: "today" as const, taskId: null },
    { view: "board" as const, taskId: "abc123" },
    { view: "quickstart" as const, taskId: null },
  ]) {
    expect(parseHash(formatHash(route))).toEqual(route);
  }
});

test("formatHash omits the query when no task is open", () => {
  expect(formatHash({ view: "board", taskId: null })).toBe("board");
  expect(formatHash({ view: "board", taskId: "abc" })).toBe("board?task=abc");
});

test("task ids survive URL encoding round-trips", () => {
  const route = { view: "board" as const, taskId: "weird id&chars=1" };
  expect(parseHash(`#${formatHash(route)}`)).toEqual(route);
});
