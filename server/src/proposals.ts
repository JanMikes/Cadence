import type { Proposal } from "@cadence/shared";
import type { Db } from "./db/client";
import { computeSelfMonitor } from "./selfmonitor";
import { runSweep } from "./sweep";
import type { WsHub } from "./ws";

/**
 * Proactive proposals (spec §8.1/§10.2): occasional, propose-don't-impose nudges
 * distilled from the sweep + self-monitor — "deadlines at risk", "stale tasks —
 * review?", "corrections to learn — Reflect?". Pure; ids embed the count so a
 * changed situation re-proposes but a static one doesn't re-nag.
 */
const plural = (n: number) => (n === 1 ? "" : "s");

export function buildProposals(db: Db, now: number = Date.now()): Proposal[] {
  const sweep = runSweep(db, now);
  const atRisk = sweep.findings.filter((f) => f.kind === "at_risk").length;
  const stale = sweep.findings.filter((f) => f.kind === "stale").length;
  const mon = computeSelfMonitor(db, now);
  const corrections = mon.provenance.edited + mon.provenance.overridden;

  const proposals: Proposal[] = [];
  if (atRisk > 0) {
    proposals.push({
      id: `deadline:${atRisk}`,
      kind: "deadline",
      title: "Deadlines at risk",
      message: `${atRisk} task${plural(atRisk)} due soon or overdue — plan them into today?`,
      count: atRisk,
    });
  }
  if (stale > 0) {
    proposals.push({
      id: `stale:${stale}`,
      kind: "stale",
      title: "Stale tasks",
      message: `${stale} task${plural(stale)} idling a while — review or archive?`,
      count: stale,
    });
  }
  if (corrections >= 3) {
    proposals.push({
      id: `reflect:${corrections}`,
      kind: "reflect",
      title: "Lessons to learn",
      message: `${corrections} corrections on record — Reflect to update memory?`,
      count: corrections,
    });
  }
  return proposals;
}

/**
 * Emit any not-yet-seen proposals as `notify` events (deduped via `emitted`).
 * Called from the background sweep tick. Returns the proposals newly emitted.
 */
export function emitProposals(
  db: Db,
  hub: WsHub,
  emitted: Set<string>,
  now: number = Date.now(),
): Proposal[] {
  const fresh = buildProposals(db, now).filter((p) => !emitted.has(p.id));
  for (const p of fresh) {
    emitted.add(p.id);
    hub.broadcast({ type: "event", name: "notify", payload: { kind: "info", title: p.title, message: p.message } });
  }
  return fresh;
}
