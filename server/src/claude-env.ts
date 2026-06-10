/**
 * Subscription-billing guard. Cadence runs on the Claude subscription (locked
 * decision: "Usage = ambient subscription-window bar, no marginal $"); Claude Code
 * silently switches to pay-per-token API billing whenever ANTHROPIC_API_KEY is
 * present in its environment. A key exported in a shell profile for some unrelated
 * project must never flip every agent run to API billing — so every claude
 * subprocess (CLI one-shots, SDK runs, warm chats) gets its env through here,
 * with the key stripped. Explicit opt-in: CADENCE_ALLOW_API_BILLING=1.
 */
export function claudeSubprocessEnv(): Record<string, string | undefined> {
  if (process.env.CADENCE_ALLOW_API_BILLING === "1") return { ...process.env };
  const { ANTHROPIC_API_KEY: dropped, ...rest } = process.env;
  if (dropped) {
    console.warn(
      "[cadence] ANTHROPIC_API_KEY is set but ignored — agent runs use the Claude subscription. " +
        "Set CADENCE_ALLOW_API_BILLING=1 to opt into API billing.",
    );
  }
  return rest;
}
