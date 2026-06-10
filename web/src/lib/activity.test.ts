import { afterAll, beforeAll, expect, test } from "bun:test";
import { _activitySnapshot, _resetActivity, _subscribeActivity } from "./activity";
import { _resetWs, _setWsTimings } from "./ws";

/**
 * The activity store must stay honest across connection gaps: re-hydrate from
 * GET /api/activity on every (re)connect, and clear itself on a hard disconnect so a
 * dead gateway can never leave "agent working" spinners on screen.
 */

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  serverOpens(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverSends(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const latest = (): MockWebSocket => {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error("no socket");
  return ws;
};

const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
const hadWindow = "window" in globalThis;
const realWindow = (globalThis as Record<string, unknown>).window;

/** What the next GET /api/activity hydration returns. */
let serverActivity: Array<{ taskId: string; stage: string; startedAt: number }> = [];

beforeAll(() => {
  (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
  if (!hadWindow) {
    (globalThis as Record<string, unknown>).window = {
      location: { protocol: "http:", host: "localhost:0" },
      addEventListener: () => {},
    };
  }
  (globalThis as Record<string, unknown>).fetch = async () => ({
    json: async () => serverActivity,
  });
});

afterAll(() => {
  (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  (globalThis as Record<string, unknown>).fetch = realFetch;
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = realWindow;
  _resetWs();
  _resetActivity();
});

test("hydrates on connect, applies WS events, re-hydrates after a gap, clears on hard disconnect", async () => {
  _resetWs();
  _setWsTimings({
    heartbeatIntervalMs: 10_000, // out of the way for this test
    heartbeatTimeoutMs: 10_000,
    disconnectGraceMs: 40,
    backoffMs: [5, 10],
  });
  MockWebSocket.instances = [];
  _resetActivity();

  const unsub = _subscribeActivity(() => {});

  // -- first connect: snapshot hydration --
  serverActivity = [{ taskId: "t1", stage: "triage", startedAt: 100 }];
  latest().serverOpens();
  await sleep(5); // hydrate fetch resolves
  expect(_activitySnapshot()).toEqual({ t1: { stage: "triage", startedAt: 100 } });

  // -- live WS events on top, startedAt carried through --
  latest().serverSends({
    type: "event",
    name: "activity:start",
    payload: { taskId: "t2", stage: "implementer", startedAt: 200 },
  });
  expect(_activitySnapshot().t2).toEqual({ stage: "implementer", startedAt: 200 });
  latest().serverSends({ type: "event", name: "activity:end", payload: { taskId: "t2", next: null } });
  expect(_activitySnapshot().t2).toBeUndefined();

  // -- a queued execution's detail (WHO it waits for) rides the event into the store --
  latest().serverSends({
    type: "event",
    name: "activity:start",
    payload: { taskId: "t4", stage: "queued", startedAt: 250, detail: "the task “Fix login”" },
  });
  expect(_activitySnapshot().t4).toEqual({
    stage: "queued",
    startedAt: 250,
    detail: "the task “Fix login”",
  });
  latest().serverSends({ type: "event", name: "activity:end", payload: { taskId: "t4", next: null } });

  // -- hard disconnect (past the grace window): never show unverifiable spinners --
  latest().close();
  await sleep(60);
  expect(_activitySnapshot()).toEqual({});

  // -- gateway returns with a different reality: full-replace drops the missed-end t1 --
  serverActivity = [{ taskId: "t3", stage: "verifier", startedAt: 300 }];
  latest().serverOpens();
  await sleep(5);
  expect(_activitySnapshot()).toEqual({ t3: { stage: "verifier", startedAt: 300 } });

  unsub();
});
