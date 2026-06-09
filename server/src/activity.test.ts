import { expect, test } from "bun:test";
import { ActivityTracker } from "./activity";

test("track() marks busy during fn, clears after, and broadcasts start→end", async () => {
  const events: Array<{ name: string; payload: { taskId: string; stage?: string } }> = [];
  let clock = 1000;
  const a = new ActivityTracker((name, payload) => events.push({ name, payload }), () => clock);

  expect(a.isActive("t1")).toBe(false);
  const result = await a.track("t1", "discovery", async () => {
    expect(a.isActive("t1")).toBe(true);
    expect(a.list()).toEqual([{ taskId: "t1", stage: "discovery", startedAt: 1000 }]);
    clock = 2000;
    return 42;
  });

  expect(result).toBe(42);
  expect(a.isActive("t1")).toBe(false);
  expect(a.list()).toEqual([]);
  expect(events.map((e) => e.name)).toEqual(["activity:start", "activity:end"]);
  expect(events[0]?.payload).toEqual({ taskId: "t1", stage: "discovery" });
});

test("track() clears + emits end even when fn throws", async () => {
  const events: string[] = [];
  const a = new ActivityTracker((name) => events.push(name));
  await expect(
    a.track("t2", "triage", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(a.isActive("t2")).toBe(false);
  expect(events).toEqual(["activity:start", "activity:end"]);
});
