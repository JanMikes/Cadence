/**
 * Shared constants & types — the server ⇄ web contract.
 * Grows as Cadence's API/storage shape evolves (typed contract lands in 0.6).
 */

export const APP_NAME = "Cadence" as const;
export const APP_TAGLINE = "Your backlog, in flow." as const;

/** Bumped whenever the on-disk / API contract changes. */
export const SCHEMA_VERSION = 1 as const;

export interface HealthStatus {
  ok: boolean;
  app: typeof APP_NAME;
  version: number;
}
