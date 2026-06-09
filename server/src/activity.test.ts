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

test("concurrent stages on one task don't corrupt each other (§6.1.f)", () => {
  const ends: Array<{ taskId: string; stage?: string; next?: string | null }> = [];
  const a = new ActivityTracker((name, payload) => {
    if (name === "activity:end") ends.push(payload);
  });

  a.start("t1", "discovery");
  a.start("t1", "questioner"); // a second stage joins — must not overwrite the first
  expect(a.list().map((e) => e.stage)).toEqual(["discovery", "questioner"]);

  a.end("t1", "discovery"); // the FIRST stage ends — the survivor must keep the task busy
  expect(a.isActive("t1")).toBe(true);
  expect(a.list().map((e) => e.stage)).toEqual(["questioner"]);
  expect(ends[0]).toEqual({ taskId: "t1", stage: "discovery", next: "questioner" });

  a.end("t1", "questioner");
  expect(a.isActive("t1")).toBe(false);
  expect(ends[1]).toEqual({ taskId: "t1", stage: "questioner", next: null });
});

test("end() is precise: unknown stage is a no-op; without a stage it pops the newest", () => {
  const a = new ActivityTracker(() => {});
  a.start("t1", "implementer");
  a.end("t1", "verifier"); // not running — must not eat the implementer entry
  expect(a.isActive("t1")).toBe(true);
  a.end("t1"); // stage omitted → newest entry
  expect(a.isActive("t1")).toBe(false);
  a.end("t1"); // already idle → no-op, no throw
  expect(a.isActive("t1")).toBe(false);
});
