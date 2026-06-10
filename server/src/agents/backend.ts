import type { AgentResult } from "@cadence/shared";
import type { AskGate } from "./ask-gate";
import { type AgentRunOptions, runAgent } from "./runner";
import { makeSdkRunner, SdkUnavailableError } from "./sdk-runner";

/**
 * Engine policy for one-shot agents — a Cadence-internal concern, not a user
 * setting. Both engines are first-class and used BY DESIGN:
 *
 *   - The Agent SDK is primary: its `canUseTool` gate is the only surface that can
 *     hold a run alive while a question travels to the web UI and back.
 *   - The raw CLI is the always-available fallback: if the SDK cannot start at all
 *     (SdkUnavailableError — no event ever arrived), the run transparently retries
 *     on the CLI, where the intercept-and-park layers still guarantee no dead ends.
 *
 * Reliability mechanics: a startup failure trips a cool-down breaker so subsequent
 * runs go straight to the CLI (no per-run double spawn attempts), and the SDK is
 * re-tried after the cool-down — self-healing, no human decision involved.
 * CADENCE_RUNNER_BACKEND=cli|sdk exists as an ops/debug lever only (forces one
 * engine; not exposed anywhere in the product).
 */

/** After an SDK startup failure, route to the CLI for this long before re-trying. */
const SDK_RETRY_COOLDOWN_MS = 30 * 60_000;

type Runner = (opts: AgentRunOptions) => Promise<AgentResult>;

export function makeBackendRunner(
  deps: { askGate?: AskGate; sdkRunner?: Runner; cliRunner?: Runner } = {},
): Runner {
  const sdk = deps.sdkRunner ?? makeSdkRunner({ askGate: deps.askGate });
  const cli = deps.cliRunner ?? runAgent;
  let cliUntil = 0; // breaker: 0 = SDK healthy

  return async (opts: AgentRunOptions): Promise<AgentResult> => {
    // Injected mock commands (tests) always take the CLI spawn path — that's the contract.
    if (opts.command) return cli(opts);
    const forced = process.env.CADENCE_RUNNER_BACKEND;
    if (forced === "cli") return cli(opts);
    if (forced !== "sdk" && Date.now() < cliUntil) return cli(opts);
    try {
      const result = await sdk(opts);
      cliUntil = 0; // a healthy SDK run closes the breaker
      return result;
    } catch (err) {
      if (err instanceof SdkUnavailableError) {
        cliUntil = Date.now() + SDK_RETRY_COOLDOWN_MS;
        console.warn(
          `[cadence] SDK engine unavailable (${err.message.slice(0, 200)}) — using the CLI engine for ` +
            `${Math.round(SDK_RETRY_COOLDOWN_MS / 60_000)} min, then re-trying the SDK`,
        );
        return cli(opts);
      }
      throw err;
    }
  };
}
