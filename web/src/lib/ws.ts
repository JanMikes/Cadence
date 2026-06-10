import type { ServerMessage } from "@cadence/shared";
import { useEffect, useRef, useSyncExternalStore } from "react";

type Listener = (msg: ServerMessage) => void;

// ---------------------------------------------------------------- connection state
// The UI must never claim a health it can't prove (display-logic rule: no false
// positives). Liveness is app-level: the browser can't observe protocol ping/pong
// frames, so we send our own {type:"ping"} and treat *any* inbound message as proof
// of life. Every failure (close, error, missed pong) funnels into one reconnect path.

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface ConnectionStatus {
  state: ConnectionState;
  /** When this state was entered (epoch ms). */
  since: number;
  /** Gateway identity from the last `hello` (replaces the old one-shot /api/health). */
  server: { app: string; version: number } | null;
}

// Timings are `let` only so tests can shrink them (see _setWsTimings).
/** Ping cadence while open; loopback pings are ~free. */
let HEARTBEAT_INTERVAL_MS = 15_000;
/** A pong (or any message) must arrive this soon after a ping, or the socket is presumed half-open. */
let HEARTBEAT_TIMEOUT_MS = 5_000;
/** Amber→red: how long a loss may last before it's a real outage, not a blip. */
let DISCONNECT_GRACE_MS = 10_000;
/** Reconnect backoff; capped so a restarted gateway/sidecar is picked up within ≤5s. */
let BACKOFF_MS = [500, 1000, 2000, 5000];

const listeners = new Set<Listener>();
const connListeners = new Set<() => void>();
const reconnectCallbacks = new Set<() => void>();

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongDeadline: ReturnType<typeof setTimeout> | null = null;
let redTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let lastInboundAt = 0;
let lastTickAt = 0;
let status: ConnectionStatus = { state: "connecting", since: Date.now(), server: null };

function setState(state: ConnectionState): void {
  if (status.state === state) return;
  status = { ...status, state, since: Date.now() };
  for (const l of connListeners) l();
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

/** Arm the amber→red escalation (idempotent; cleared on open). */
function armRedTimer(): void {
  if (redTimer != null) return;
  redTimer = setTimeout(() => {
    redTimer = null;
    if (status.state !== "connected") setState("disconnected");
  }, DISCONNECT_GRACE_MS);
}

function clearRedTimer(): void {
  if (redTimer != null) clearTimeout(redTimer);
  redTimer = null;
}

function sendPing(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const t = Date.now();
  socket.send(JSON.stringify({ type: "ping", t }));
  if (pongDeadline != null) clearTimeout(pongDeadline);
  pongDeadline = setTimeout(() => {
    pongDeadline = null;
    // Nothing arrived since the ping → half-open/dead socket. Close it so the
    // normal onclose → reconnect path takes over (one code path for all failures).
    if (lastInboundAt < t && socket) socket.close();
  }, HEARTBEAT_TIMEOUT_MS);
}

function startHeartbeat(): void {
  stopHeartbeat();
  lastTickAt = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    // A wall-clock gap ≫ the interval means the machine slept (or the tab was
    // heavily throttled) — the socket may be silently dead; verify right away.
    const slept = now - lastTickAt > 2 * HEARTBEAT_INTERVAL_MS;
    lastTickAt = now;
    // Skip the ping when event traffic already proved liveness this interval.
    if (slept || now - lastInboundAt >= HEARTBEAT_INTERVAL_MS * 0.75) sendPing();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer != null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (pongDeadline != null) clearTimeout(pongDeadline);
  pongDeadline = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer != null) return;
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 5000;
  attempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, delay);
}

function ensureSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  // The very first failed attempt must also escalate to red eventually — a gateway
  // that's down at launch is "Disconnected", not an eternal "Connecting…".
  armRedTimer();
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    attempt = 0;
    lastInboundAt = Date.now();
    clearRedTimer();
    setState("connected");
    startHeartbeat();
    for (const cb of reconnectCallbacks) cb();
  };
  socket.onmessage = (e) => {
    lastInboundAt = Date.now();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(e.data as string) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      status = { ...status, server: { app: msg.app, version: msg.version } };
      for (const l of connListeners) l();
    }
    if (msg.type === "pong") return; // liveness only — already recorded above
    for (const l of listeners) l(msg);
  };
  socket.onclose = () => {
    socket = null;
    stopHeartbeat();
    // Never jump straight to red: a 1s blip (dev restart) stays amber.
    if (status.state === "connected") setState("reconnecting");
    armRedTimer();
    scheduleReconnect();
  };
  socket.onerror = () => {
    // onclose follows and owns the transition; nothing to do here.
  };
}

// Waking up (tab shown, window focused, network back) is the moment stale state is most
// likely: timers were throttled or the machine slept. Verify or reconnect *now*.
// `navigator.onLine` is deliberately NOT a disconnect signal — the gateway lives on
// loopback, which works fine with Wi-Fi off; `online` is only a free "retry now" nudge.
function verifyNow(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    attempt = 0;
    ensureSocket();
  } else if (socket?.readyState === WebSocket.OPEN) {
    sendPing();
  }
}
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") verifyNow();
  });
  window.addEventListener("focus", verifyNow);
  window.addEventListener("online", verifyNow);
}

/** Subscribe to gateway ServerMessages; returns an unsubscribe fn. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  ensureSocket();
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: invoke `handler` for every gateway message (latest closure used). */
export function useServerMessages(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((msg) => ref.current(msg)), []);
}

/** Current connection snapshot (state machine above). */
export function getConnectionStatus(): ConnectionStatus {
  return status;
}

/** Store-style subscription to connection-state changes. Keeps the socket alive on its own. */
export function subscribeConnection(cb: () => void): () => void {
  connListeners.add(cb);
  ensureSocket();
  return () => {
    connListeners.delete(cb);
  };
}

/** React hook: live connection status (connecting / connected / reconnecting / disconnected). */
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribeConnection, getConnectionStatus, getConnectionStatus);
}

/**
 * Run `cb` on EVERY entry into "connected" — including the first. Consumers use one
 * path for both initial hydration and post-gap resync (events missed while down).
 */
export function onReconnect(cb: () => void): () => void {
  reconnectCallbacks.add(cb);
  if (status.state === "connected") cb();
  return () => {
    reconnectCallbacks.delete(cb);
  };
}

/** Test-only: shrink the timing constants so state-machine tests run in milliseconds. */
export function _setWsTimings(t: {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  disconnectGraceMs?: number;
  backoffMs?: number[];
}): void {
  HEARTBEAT_INTERVAL_MS = t.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  HEARTBEAT_TIMEOUT_MS = t.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  DISCONNECT_GRACE_MS = t.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
  BACKOFF_MS = t.backoffMs ?? BACKOFF_MS;
}

/** Test-only: tear down the singleton so each test starts cold. */
export function _resetWs(): void {
  stopHeartbeat();
  clearRedTimer();
  if (reconnectTimer != null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = null;
  attempt = 0;
  lastInboundAt = 0;
  status = { state: "connecting", since: Date.now(), server: null };
}
