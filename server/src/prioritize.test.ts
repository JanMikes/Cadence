import { expect, test } from "bun:test";
import { deadlineBand, priorityWeight, sortByUrgency, urgencyScore, urgencyTier } from "./prioritize";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

test("priorityWeight handles P0..P3, named levels, and null", () => {
  expect(priorityWeight("P0")).toBe(3);
  expect(priorityWeight("urgent")).toBe(3);
  expect(priorityWeight("P1")).toBe(2);
  expect(priorityWeight("high")).toBe(2);
  expect(priorityWeight("P2")).toBe(1);
  expect(priorityWeight("medium")).toBe(1);
  expect(priorityWeight("P3")).toBe(0);
  expect(priorityWeight("low")).toBe(0);
  expect(priorityWeight(null)).toBe(0.5);
  expect(priorityWeight("weird")).toBe(0.5);
});

test("deadlineBand: overdue dominates, banded by proximity, null = 0", () => {
  expect(deadlineBand(null, NOW)).toBe(0);
  expect(deadlineBand(NOW - DAY, NOW)).toBe(50); // overdue
  expect(deadlineBand(NOW + DAY / 2, NOW)).toBe(40); // within a day
  expect(deadlineBand(NOW + 2 * DAY, NOW)).toBe(30); // within 3 days
  expect(deadlineBand(NOW + 5 * DAY, NOW)).toBe(20); // within a week
  expect(deadlineBand(NOW + 10 * DAY, NOW)).toBe(10); // within two weeks
  expect(deadlineBand(NOW + 60 * DAY, NOW)).toBe(5); // far off
});

test("deadlines dominate priority across bands, priority breaks ties within a band", () => {
  // an overdue low-priority task outranks a due-next-week urgent one
  const overdueLow = { deadline: NOW - DAY, priority: "P3" };
  const soonUrgent = { deadline: NOW + 5 * DAY, priority: "P0" };
  expect(urgencyScore(overdueLow, NOW)).toBeGreaterThan(urgencyScore(soonUrgent, NOW));

  // same band → priority decides
  const sameBandHi = { deadline: NOW + 2 * DAY, priority: "P0" };
  const sameBandLo = { deadline: NOW + 2 * DAY, priority: "P3" };
  expect(urgencyScore(sameBandHi, NOW)).toBeGreaterThan(urgencyScore(sameBandLo, NOW));
});

test("urgencyTier classifies by deadline proximity", () => {
  expect(urgencyTier({ deadline: null }, NOW)).toBe("none");
  expect(urgencyTier({ deadline: NOW - DAY }, NOW)).toBe("overdue");
  expect(urgencyTier({ deadline: NOW + 2 * DAY }, NOW)).toBe("due_soon");
  expect(urgencyTier({ deadline: NOW + 10 * DAY }, NOW)).toBe("upcoming");
});

test("sortByUrgency orders most-urgent first, newest-first on ties", () => {
  const tasks = [
    { id: "far", deadline: NOW + 30 * DAY, priority: "P1", createdAt: 1 },
    { id: "overdue", deadline: NOW - DAY, priority: "P3", createdAt: 2 },
    { id: "soon", deadline: NOW + 2 * DAY, priority: "P0", createdAt: 3 },
    { id: "none-new", deadline: null, priority: "P0", createdAt: 5 },
    { id: "none-old", deadline: null, priority: "P0", createdAt: 4 },
  ];
  const order = sortByUrgency(tasks, NOW).map((t) => t.id);
  expect(order[0]).toBe("overdue");
  expect(order[1]).toBe("soon");
  expect(order[2]).toBe("far");
  // the two deadline-less P0 tasks tie on score → newest (higher createdAt) first
  expect(order[3]).toBe("none-new");
  expect(order[4]).toBe("none-old");
});
