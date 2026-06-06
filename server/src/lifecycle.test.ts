import { expect, test } from "bun:test";
import { allowedTransitions, canTransition, isValidStatus } from "./lifecycle";

test("isValidStatus accepts known statuses, rejects garbage", () => {
  expect(isValidStatus("ready")).toBe(true);
  expect(isValidStatus("done")).toBe(true);
  expect(isValidStatus("nonsense")).toBe(false);
  expect(isValidStatus("")).toBe(false);
});

test("canTransition follows the canonical agent path", () => {
  expect(canTransition("inbox", "triaged")).toBe(true);
  expect(canTransition("triaged", "refining")).toBe(true);
  expect(canTransition("refining", "needs_feedback")).toBe(true);
  expect(canTransition("needs_feedback", "ready")).toBe(true);
  expect(canTransition("ready", "implementing")).toBe(true);
  expect(canTransition("implementing", "verifying")).toBe(true);
  expect(canTransition("verifying", "review")).toBe(true);
  expect(canTransition("review", "done")).toBe(true);
});

test("any active state can be parked to blocked or cancelled", () => {
  for (const s of ["inbox", "refining", "implementing", "review"]) {
    expect(canTransition(s, "blocked")).toBe(true);
    expect(canTransition(s, "cancelled")).toBe(true);
  }
});

test("terminal/side states reopen only to sensible re-entry points", () => {
  // cancelled → only inbox/ready
  expect(canTransition("cancelled", "inbox")).toBe(true);
  expect(canTransition("cancelled", "ready")).toBe(true);
  expect(canTransition("cancelled", "verifying")).toBe(false);
  // done → only ready/review
  expect(canTransition("done", "ready")).toBe(true);
  expect(canTransition("done", "review")).toBe(true);
  expect(canTransition("done", "implementing")).toBe(false);
  // blocked un-parks to any active state, not to done
  expect(canTransition("blocked", "implementing")).toBe(true);
  expect(canTransition("blocked", "done")).toBe(false);
});

test("no-op and unknown-target transitions", () => {
  expect(canTransition("ready", "ready")).toBe(true);
  expect(canTransition("ready", "nonsense")).toBe(false);
});

test("allowedTransitions excludes self and only lists valid targets", () => {
  const from = "ready";
  const allowed = allowedTransitions(from);
  expect(allowed).not.toContain(from);
  expect(allowed.every((to) => canTransition(from, to))).toBe(true);
  expect(allowed).toContain("implementing");
  expect(allowed).toContain("blocked");
});
