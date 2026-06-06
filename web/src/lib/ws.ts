import type { ServerMessage } from "@cadence/shared";
import { useEffect, useRef } from "react";

type Listener = (msg: ServerMessage) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

function ensureSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  socket = new WebSocket(wsUrl());
  socket.onmessage = (e) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(e.data as string) as ServerMessage;
    } catch {
      return;
    }
    for (const l of listeners) l(msg);
  };
  socket.onclose = () => {
    socket = null;
    if (listeners.size > 0 && reconnectTimer == null) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (listeners.size > 0) ensureSocket();
      }, 1000);
    }
  };
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
