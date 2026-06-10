import { afterEach, expect, test } from "bun:test";
import { claudeSubprocessEnv } from "./claude-env";

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CADENCE_ALLOW_API_BILLING;
});

test("strips a stray ANTHROPIC_API_KEY so agent runs stay on the subscription", () => {
  process.env.ANTHROPIC_API_KEY = "fake-stray-key-for-test"; // cadence-allow-secret
  const env = claudeSubprocessEnv();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.PATH).toBe(process.env.PATH); // everything else inherited
});

test("CADENCE_ALLOW_API_BILLING=1 is the explicit opt-in that keeps the key", () => {
  process.env.ANTHROPIC_API_KEY = "fake-wanted-key-for-test"; // cadence-allow-secret
  process.env.CADENCE_ALLOW_API_BILLING = "1";
  expect(claudeSubprocessEnv().ANTHROPIC_API_KEY).toBe("fake-wanted-key-for-test");
});
