import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  _resetWs,
  _setWsTimings,
  getConnectionStatus,
  onReconnect,
  subscribeConnection,
  type ConnectionState,
} from "./ws";

/**
 * State-machine tests for the connection layer. A mock WebSocket lets the test drive
 * open/message/close by hand; timings are shrunk to milliseconds via _setWsTimings.
 */

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  // -- test drivers --
  serverOpens(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
    this.serverSends({ type: "hello", app: "Cadence", version: 1 });
  }

  serverSends(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverDies(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function latest(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error("no socket was opened");
  return ws;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const realWebSocket = globalThis.WebSocket;
const hadWindow = "window" in globalThis;
const realWindow = (globalThis as Record<string, unknown>).window;

beforeAll(() => {
  (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
  // wsUrl() needs window.location; the module-level visibility wiring is import-time
  // and already settled, so a minimal window is enough here.
  if (!hadWindow) {
    (globalThis as Record<string, unknown>).window = {
      location: { protocol: "http:", host: "localhost:0" },
      addEventListener: () => {},
    };
  }
});

afterAll(() => {
  (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = realWindow;
  _resetWs();
});

let unsubs: Array<() => void> = [];

beforeEach(() => {
  _resetWs();
  MockWebSocket.instances = [];
  _setWsTimings({
    heartbeatIntervalMs: 30,
    heartbeatTimeoutMs: 20,
    disconnectGraceMs: 60,
    backoffMs: [5, 10],
  });
});

afterEach(() => {
  for (const u of unsubs) u();
  unsubs = [];
  _resetWs();
});

function watchStates(): ConnectionState[] {
  const seen: ConnectionState[] = [getConnectionStatus().state];
  unsubs.push(
    subscribeConnection(() => {
      const s = getConnectionStatus().state;
      if (seen.at(-1) !== s) seen.push(s);
    }),
  );
  return seen;
}

test("connects on first subscriber; open → connected; hello fills server identity; onReconnect fires", () => {
  const seen = watchStates();
  let reconnects = 0;
  unsubs.push(onReconnect(() => reconnects++));

  expect(seen[0]).toBe("connecting");
  latest().serverOpens();

  expect(getConnectionStatus().state).toBe("connected");
  expect(getConnectionStatus().server).toEqual({ app: "Cadence", version: 1 });
  expect(reconnects).toBe(1); // first connect counts — one path for hydrate + resync
});

test("a quick blip stays amber (reconnecting) and never reaches red", async () => {
  const seen = watchStates();
  latest().serverOpens();

  latest().serverDies();
  expect(getConnectionStatus().state).toBe("reconnecting");

  await sleep(15); // backoff (5ms) has fired a new attempt; grace (60ms) has not elapsed
  latest().serverOpens();
  expect(getConnectionStatus().state).toBe("connected");
  expect(seen).not.toContain("disconnected");
});

test("a sustained outage escalates amber → red, then recovers and refires onReconnect", async () => {
  const seen = watchStates();
  let reconnects = 0;
  unsubs.push(onReconnect(() => reconnects++));
  latest().serverOpens();

  latest().serverDies();
  await sleep(90); // past the 60ms grace
  expect(getConnectionStatus().state).toBe("disconnected");

  latest().serverOpens(); // gateway came back on a retry attempt
  expect(getConnectionStatus().state).toBe("connected");
  expect(reconnects).toBe(2);
  expect(seen).toEqual(["connecting", "connected", "reconnecting", "disconnected", "connected"]);
});

test("a gateway that is down at launch goes red, not eternal 'connecting'", async () => {
  watchStates();
  expect(getConnectionStatus().state).toBe("connecting");
  await sleep(90); // never opens; past grace
  expect(getConnectionStatus().state).toBe("disconnected");
});

test("heartbeat: a missed pong closes the half-open socket and reconnects", async () => {
  watchStates();
  const first = latest();
  first.serverOpens();

  // Wait past one heartbeat interval (30ms): a ping goes out, nothing comes back,
  // the 20ms pong deadline closes the socket → reconnecting.
  await sleep(80);
  expect(first.sent.some((m) => (JSON.parse(m) as { type: string }).type === "ping")).toBe(true);
  expect(getConnectionStatus().state === "reconnecting" || getConnectionStatus().state === "disconnected").toBe(true);
  expect(MockWebSocket.instances.length).toBeGreaterThan(1); // a retry attempt was made
});

test("heartbeat: pongs keep a healthy connection green", async () => {
  const seen = watchStates();
  const ws = latest();
  ws.serverOpens();

  // Auto-answer every ping like the real gateway does.
  const answer = setInterval(() => {
    for (const m of ws.sent.splice(0)) {
      const msg = JSON.parse(m) as { type: string; t: number };
      if (msg.type === "ping") ws.serverSends({ type: "pong", t: msg.t });
    }
  }, 5);

  await sleep(120); // several heartbeat cycles
  clearInterval(answer);
  expect(seen).toEqual(["connecting", "connected"]);
});
