import { expect, test } from "bun:test";
import type { Task } from "@cadence/shared";
import { dayKey, monthGrid, tasksByDay } from "./calendar";

test("monthGrid is a Monday-first 6×7 grid covering the month", () => {
  const grid = monthGrid(2026, 5); // June 2026 (June 1 is a Monday)
  expect(grid).toHaveLength(6);
  expect(grid[0]).toHaveLength(7);
  expect(grid[0]?.[0]?.key).toBe("2026-06-01"); // starts on Mon June 1
  expect(grid[0]?.[0]?.inMonth).toBe(true);
  // a day from the trailing week belongs to July (not in month)
  const lastCell = grid[5]?.[6];
  expect(lastCell?.inMonth).toBe(false);
});

test("monthGrid pads leading days from the previous month", () => {
  const grid = monthGrid(2026, 6); // July 2026 — July 1 is a Wednesday
  expect(grid[0]?.[0]?.key).toBe("2026-06-29"); // Monday before
  expect(grid[0]?.[0]?.inMonth).toBe(false);
  expect(grid[0]?.[2]?.key).toBe("2026-07-01"); // Wed = July 1
  expect(grid[0]?.[2]?.inMonth).toBe(true);
});

test("tasksByDay groups by local deadline day and skips deadline-less tasks", () => {
  const at = (s: string) => new Date(s).getTime();
  const tasks = [
    { id: "a", deadline: at("2026-06-10T09:00:00") },
    { id: "b", deadline: at("2026-06-10T18:00:00") },
    { id: "c", deadline: at("2026-06-11T08:00:00") },
    { id: "d", deadline: null },
  ] as Task[];
  const map = tasksByDay(tasks);
  expect(map.get(dayKey(at("2026-06-10T12:00:00")))?.map((t) => t.id)).toEqual(["a", "b"]);
  expect(map.get("2026-06-11")?.map((t) => t.id)).toEqual(["c"]);
  expect([...map.values()].flat()).toHaveLength(3); // d (no deadline) excluded
});
