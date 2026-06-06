import { expect, test } from "bun:test";
import { APP_NAME, APP_TAGLINE, SCHEMA_VERSION } from "./index";

test("shared exposes app identity", () => {
  expect(APP_NAME).toBe("Cadence");
  expect(APP_TAGLINE).toContain("flow");
  expect(SCHEMA_VERSION).toBeGreaterThan(0);
});
