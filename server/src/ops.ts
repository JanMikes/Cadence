import { readSettings } from "./store/store";

/**
 * Operations knobs (plan §6.3.e) — the §6.1 safety constants, now user-tunable in
 * Settings → Operations. Only customized values persist (settings.operations);
 * everything falls back to the defaults below, and invalid values (≤0, NaN) are
 * ignored so a hand-edited settings.json can never disable a safety net.
 */

export interface OpsSettings {
  /** Minutes a running session may go without transcript activity before the "looks stuck" nudge. */
  stuckThresholdMinutes: number;
  /** Hard ceiling for read stages (triage/discovery/questioner/planner/delivery/…). */
  readStageTimeoutMinutes: number;
  /** Hard ceiling for implementer/verifier runs (real builds + tests take longer). */
  implementStageTimeoutMinutes: number;
  /** Max automatic spawns of one stage per task per 24h (the §6.1.c circuit breaker). */
  maxStageAttemptsPer24h: number;
  /** Global cap on concurrently-live one-shot agents (money valve). */
  maxConcurrentAgents: number;
  /** Minutes a paused run waits for the user to answer an agent question / approve a
   *  tool before it proceeds without (the stage clock pauses while waiting). */
  askWaitMinutes: number;
}

export const OPS_DEFAULTS: OpsSettings = {
  stuckThresholdMinutes: 10,
  readStageTimeoutMinutes: 15,
  implementStageTimeoutMinutes: 60,
  maxStageAttemptsPer24h: 3,
  maxConcurrentAgents: 4,
  askWaitMinutes: 10,
};

function sane(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The effective operations settings: user overrides over defaults, sanitized. */
export function opsSettings(): OpsSettings {
  let raw: Partial<Record<keyof OpsSettings, unknown>> = {};
  try {
    raw = (readSettings().operations ?? {}) as typeof raw;
  } catch {
    /* unreadable settings must never break a safety net — use defaults */
  }
  return {
    stuckThresholdMinutes: sane(raw.stuckThresholdMinutes, OPS_DEFAULTS.stuckThresholdMinutes),
    readStageTimeoutMinutes: sane(raw.readStageTimeoutMinutes, OPS_DEFAULTS.readStageTimeoutMinutes),
    implementStageTimeoutMinutes: sane(
      raw.implementStageTimeoutMinutes,
      OPS_DEFAULTS.implementStageTimeoutMinutes,
    ),
    maxStageAttemptsPer24h: sane(raw.maxStageAttemptsPer24h, OPS_DEFAULTS.maxStageAttemptsPer24h),
    maxConcurrentAgents: sane(raw.maxConcurrentAgents, OPS_DEFAULTS.maxConcurrentAgents),
    askWaitMinutes: sane(raw.askWaitMinutes, OPS_DEFAULTS.askWaitMinutes),
  };
}

/**
 * Which engine runs one-shot agents. "sdk" (default) = the Agent SDK with the live
 * `canUseTool` ask-gate — questions reach the web UI and the run continues; "cli" =
 * the raw `claude -p` spawn (no mid-run answering; asks stop the run and become Q&A
 * cards). Env wins over settings so an incident can be steered without a UI deploy.
 */
export function runnerBackend(): "sdk" | "cli" {
  const env = process.env.CADENCE_RUNNER_BACKEND;
  if (env === "sdk" || env === "cli") return env;
  try {
    const raw = (readSettings().operations as Record<string, unknown> | undefined)?.runnerBackend;
    if (raw === "sdk" || raw === "cli") return raw;
  } catch {
    /* unreadable settings → default */
  }
  return "sdk";
}

/** Stuck threshold in ms — the CADENCE_SESSION_STUCK_MS env var stays the strongest override. */
export function stuckIdleMs(): number {
  const env = Number(process.env.CADENCE_SESSION_STUCK_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return opsSettings().stuckThresholdMinutes * 60_000;
}
