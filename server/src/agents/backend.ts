import type { AgentResult } from "@cadence/shared";
import { runnerBackend } from "../ops";
import type { AskGate } from "./ask-gate";
import { type AgentRunOptions, runAgent } from "./runner";
import { makeSdkRunner, SdkUnavailableError } from "./sdk-runner";

/**
 * Pick the one-shot engine per run: the Agent SDK (live ask-gate — questions reach
 * the web UI, the run continues) by default, the raw CLI on request
 * (operations.runnerBackend / CADENCE_RUNNER_BACKEND) or as an automatic fallback
 * when the SDK can't start at all. Tests that inject `opts.command` always get the
 * CLI path — that's the mock contract.
 */
export function makeBackendRunner(deps: { askGate?: AskGate } = {}): (
  opts: AgentRunOptions,
) => Promise<AgentResult> {
  const sdk = makeSdkRunner({ askGate: deps.askGate });
  return async (opts: AgentRunOptions): Promise<AgentResult> => {
    if (opts.command || runnerBackend() === "cli") return runAgent(opts);
    try {
      return await sdk(opts);
    } catch (err) {
      if (err instanceof SdkUnavailableError) {
        console.warn(
          `[cadence] SDK runner unavailable (${err.message.slice(0, 200)}) — falling back to the CLI runner`,
        );
        return runAgent(opts);
      }
      throw err;
    }
  };
}
