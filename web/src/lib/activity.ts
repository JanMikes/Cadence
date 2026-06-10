import { useSyncExternalStore } from "react";
import { onReconnect, subscribe as subscribeWs, subscribeConnection, getConnectionStatus } from "./ws";

/**
 * Live "work in progress" map (taskId → the autonomy stage currently working it + when it
 * started). Fed by `activity:start` / `activity:end` WS events; hydrated from GET /api/activity
 * on EVERY (re)connect, so a gap in the socket can't leave stale spinners (missed `activity:end`
 * events are dropped by the full-replace). On a hard disconnect the map is cleared — we never
 * show "agent working" the app can't verify (display-logic rule: no false positives).
 */
export interface ActivityInfo {
  stage: string;
  startedAt: number;
}

let busy: Record<string, ActivityInfo> = {};
const listeners = new Set<() => void>();
let wsWired = false;

function emit(): void {
  for (const l of listeners) l();
}

function setBusy(taskId: string, stage: string | null, startedAt?: number): void {
  if (stage === null) {
    if (!(taskId in busy)) return;
    const { [taskId]: _drop, ...rest } = busy;
    busy = rest;
  } else {
    if (busy[taskId]?.stage === stage) return;
    busy = { ...busy, [taskId]: { stage, startedAt: startedAt ?? Date.now() } };
  }
  emit();
}

async function hydrate(): Promise<void> {
  try {
    const list = (await fetch("/api/activity").then((r) => r.json())) as Array<{
      taskId: string;
      stage: string;
      startedAt?: number;
    }>;
    const next: Record<string, ActivityInfo> = {};
    for (const e of list) next[e.taskId] = { stage: e.stage, startedAt: e.startedAt ?? Date.now() };
    busy = next;
    emit();
  } catch {
    /* gateway not reachable — no activity to show */
  }
}

function wire(): void {
  if (wsWired) return;
  wsWired = true;
  // Hydrate on every entry into "connected" (incl. the first) — one path for boot + resync.
  onReconnect(() => void hydrate());
  // A hard disconnect (red, past the grace window) means the snapshot is unverifiable — clear
  // it. The brief amber "reconnecting" keeps the last known state to avoid flicker on blips.
  subscribeConnection(() => {
    if (getConnectionStatus().state === "disconnected" && Object.keys(busy).length > 0) {
      busy = {};
      emit();
    }
  });
  subscribeWs((m) => {
    if (m.type !== "event") return;
    if (m.name === "activity:start") {
      const p = m.payload as { taskId: string; stage: string; startedAt?: number };
      setBusy(p.taskId, p.stage, p.startedAt);
    } else if (m.name === "activity:end") {
      // `next` = a stage still working the task (concurrent stages, §6.1.f) — fall
      // back to it instead of going dark while work continues.
      const p = m.payload as { taskId: string; next?: string | null };
      setBusy(p.taskId, p.next ?? null);
    }
  });
}

function subscribeStore(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): Record<string, ActivityInfo> => busy;

/** Human label for an autonomy stage, for the spinner caption. */
export function stageLabel(stage: string): string {
  return (
    {
      triage: "Triaging…",
      discovery: "Refining…",
      refine: "Refining…",
      questioner: "Preparing questions…",
      reviewer: "Reviewing…",
      review_responder: "Addressing feedback…",
    }[
      stage
    ] ?? "Working…"
  );
}

/** Short noun-ish label for the header pills ("3× Triaging"). */
export function stageNoun(stage: string): string {
  return (
    {
      triage: "Triaging",
      discovery: "Refining",
      refine: "Refining",
      questioner: "Questions",
      implementer: "Implementing",
      verifier: "Verifying",
      delivery: "Delivering",
      reviewer: "Reviewing",
      review_responder: "Review replies",
      queued: "Queued",
      heal: "Healing",
    }[
      stage
    ] ?? "Working"
  );
}

/** The full taskId → activity map of in-flight autonomy work. */
export function useActivityMap(): Record<string, ActivityInfo> {
  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}

/** The stage currently working `taskId` (e.g. "discovery"), or null if idle. */
export function useActivity(taskId: string): string | null {
  return useActivityMap()[taskId]?.stage ?? null;
}

/** Test-only: reset the store. */
export function _resetActivity(): void {
  busy = {};
  emit();
}

/** Test-only: subscribe (wires the WS handlers) without a React render. */
export function _subscribeActivity(listener: () => void): () => void {
  return subscribeStore(listener);
}

/** Test-only: read the current map without a React render. */
export function _activitySnapshot(): Record<string, ActivityInfo> {
  return getSnapshot();
}
