import { useSyncExternalStore } from "react";
import { subscribe as subscribeWs } from "./ws";

/**
 * Live "work in progress" map (taskId → the autonomy stage currently working it, e.g. "discovery").
 * Fed by `activity:start` / `activity:end` WS events and hydrated once from GET /api/activity, so the
 * board + task views can show a spinner whenever a triage/discovery/questioner run is active.
 */
let busy: Record<string, string> = {};
const listeners = new Set<() => void>();
let wsWired = false;

function emit(): void {
  for (const l of listeners) l();
}

function setBusy(taskId: string, stage: string | null): void {
  if (stage === null) {
    if (!(taskId in busy)) return;
    const { [taskId]: _drop, ...rest } = busy;
    busy = rest;
  } else {
    if (busy[taskId] === stage) return;
    busy = { ...busy, [taskId]: stage };
  }
  emit();
}

async function hydrate(): Promise<void> {
  try {
    const list = (await fetch("/api/activity").then((r) => r.json())) as Array<{
      taskId: string;
      stage: string;
    }>;
    const next: Record<string, string> = {};
    for (const e of list) next[e.taskId] = e.stage;
    busy = next;
    emit();
  } catch {
    /* gateway not reachable — no activity to show */
  }
}

function subscribeStore(listener: () => void): () => void {
  if (!wsWired) {
    wsWired = true;
    void hydrate();
    subscribeWs((m) => {
      if (m.type !== "event") return;
      if (m.name === "activity:start") {
        const p = m.payload as { taskId: string; stage: string };
        setBusy(p.taskId, p.stage);
      } else if (m.name === "activity:end") {
        // `next` = a stage still working the task (concurrent stages, §6.1.f) — fall
        // back to it instead of going dark while work continues.
        const p = m.payload as { taskId: string; next?: string | null };
        setBusy(p.taskId, p.next ?? null);
      }
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): Record<string, string> => busy;

/** Human label for an autonomy stage, for the spinner caption. */
export function stageLabel(stage: string): string {
  return (
    { triage: "Triaging…", discovery: "Refining…", refine: "Refining…", questioner: "Preparing questions…" }[
      stage
    ] ?? "Working…"
  );
}

/** The full taskId → stage map of in-flight autonomy work. */
export function useActivityMap(): Record<string, string> {
  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}

/** The stage currently working `taskId` (e.g. "discovery"), or null if idle. */
export function useActivity(taskId: string): string | null {
  return useActivityMap()[taskId] ?? null;
}

/** Test-only: reset the store. */
export function _resetActivity(): void {
  busy = {};
  emit();
}
