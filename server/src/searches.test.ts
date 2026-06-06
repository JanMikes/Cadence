import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSavedSearch, deleteSavedSearch, listSavedSearches } from "./searches";
import { bootstrap } from "./store/store";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-searches-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("saved searches: create, list (oldest-first), delete", () => {
  expect(listSavedSearches()).toEqual([]);
  const a = createSavedSearch({ name: "Overdue", query: "status:blocked" }, 1000);
  const b = createSavedSearch({ name: "Auth", query: "oauth" }, 2000);
  expect(listSavedSearches().map((s) => s.name)).toEqual(["Overdue", "Auth"]);

  expect(deleteSavedSearch(a.id)).toBe(true);
  expect(listSavedSearches().map((s) => s.id)).toEqual([b.id]);
  expect(deleteSavedSearch("nope")).toBe(false);
});
