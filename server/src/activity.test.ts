import { expect, test } from "bun:test";
import { ActivityTracker } from "./activity";

test("track() marks busy during fn, clears after, and broadcasts start→end", async () => {
  const events: Array<{
    name: string;
    payload: { taskId: string; stage?: string; startedAt?: number };
  }> = [];
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
  // startedAt rides along so the UI can show live elapsed time on WS-delivered entries.
  expect(events[0]?.payload).toEqual({ taskId: "t1", stage: "discovery", startedAt: 1000 });
});

test("start() carries an optional detail (who a queued execution waits for) through list + broadcast", () => {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const a = new ActivityTracker((name, payload) => events.push({ name, payload }), () => 1000);

  a.start("t1", "queued", "the task “Fix login” (implementer)");
  expect(a.list()).toEqual([
    { taskId: "t1", stage: "queued", startedAt: 1000, detail: "the task “Fix login” (implementer)" },
  ]);
  expect(events[0]?.payload).toEqual({
    taskId: "t1",
    stage: "queued",
    startedAt: 1000,
    detail: "the task “Fix login” (implementer)",
  });

  // detail-less starts keep their exact shape (no stray `detail` key)
  a.start("t2", "triage");
  expect(a.list().at(-1)).toEqual({ taskId: "t2", stage: "triage", startedAt: 1000 });
});

test("start() carries structured blockers (ids for deep-linking) through list + broadcast", () => {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const a = new ActivityTracker((name, payload) => events.push({ name, payload }), () => 1000);

  const blockers = [
    { kind: "execution" as const, label: "the task “Fix login” (implementer)", taskId: "t-9", sessionId: "s-9" },
    { kind: "external" as const, label: "a Claude Code session outside Cadence (pid 7, /p)", pid: 7, cwd: "/p", sessionId: "ext-1" },
  ];
  a.start("t1", "queued", "the task “Fix login” (implementer), a Claude Code session…", blockers);
  expect(a.list()[0]?.blockers).toEqual(blockers);
  expect((events[0]?.payload as { blockers?: unknown }).blockers).toEqual(blockers);

  // an empty blockers array keeps the entry's exact shape (no stray key)
  a.start("t2", "queued", "someone", []);
  expect(a.list().at(-1)).toEqual({ taskId: "t2", stage: "queued", startedAt: 1000, detail: "someone" });
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

test("expire() reaps only entries past maxAge and broadcasts their end", () => {
  const ends: Array<{ taskId: string; stage?: string; next?: string | null }> = [];
  let clock = 0;
  const a = new ActivityTracker((name, payload) => {
    if (name === "activity:end") ends.push(payload);
  }, () => clock);

  a.start("t1", "implementer"); // startedAt 0 — will leak
  clock = 50_000;
  a.start("t1", "verifier"); // fresh — must survive
  a.start("t2", "triage"); // fresh — must survive

  clock = 60_000;
  expect(a.expire(30_000)).toBe(1); // only the implementer entry is past 30s
  expect(a.list().map((e) => e.stage).sort()).toEqual(["triage", "verifier"]);
  // the survivor keeps the task busy via `next`, so the UI spinner doesn't go dark
  expect(ends[0]).toEqual({ taskId: "t1", stage: "implementer", next: "verifier" });

  expect(a.expire(30_000)).toBe(0); // idempotent — nothing else is stale
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
