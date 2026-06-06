import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "./db/client";
import { bootstrap } from "./store/store";
import {
  createSuggestion,
  getSuggestion,
  listSuggestions,
  resolveSuggestion,
} from "./suggestions";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-sugg-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function make() {
  return createSuggestion(db, {
    entityType: "task",
    entityId: "task-1",
    field: "priority",
    value: "high",
    rationale: "Deadline is near",
    confidence: 0.8,
    source: "triage",
  });
}

test("createSuggestion stores a suggested-status proposal with value/rationale/confidence", () => {
  const s = make();
  expect(s.status).toBe("suggested");
  expect(s.value).toBe("high");
  expect(s.rationale).toBe("Deadline is near");
  expect(s.confidence).toBe(0.8);
  expect(s.resolvedAt).toBeNull();
  expect(listSuggestions(db, "task", "task-1").map((x) => x.id)).toContain(s.id);
});

test("accept confirms (provenance suggested → confirmed)", () => {
  const s = make();
  const r = resolveSuggestion(db, s.id, "accept");
  expect(r?.status).toBe("confirmed");
  expect(r?.value).toBe("high"); // value unchanged on accept
  expect(r?.resolvedAt).toBeGreaterThan(0);
  expect(getSuggestion(db, s.id)?.status).toBe("confirmed");
});

test("edit/override record provenance + the new value; dismiss closes it", () => {
  const edited = resolveSuggestion(db, make().id, "edit", "medium");
  expect(edited?.status).toBe("edited");
  expect(edited?.value).toBe("medium");

  const overridden = resolveSuggestion(db, make().id, "override", "low");
  expect(overridden?.status).toBe("overridden");
  expect(overridden?.value).toBe("low");

  const dismissed = resolveSuggestion(db, make().id, "dismiss");
  expect(dismissed?.status).toBe("dismissed");

  expect(resolveSuggestion(db, "no-such-id", "accept")).toBeNull();
});
