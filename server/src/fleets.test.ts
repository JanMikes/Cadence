import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { createFleet, fleetMembers, getFleet, listFleets, updateFleet } from "./fleets";
import { createProject } from "./projects";
import { bootstrap } from "./store/store";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-fleets-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("createFleet persists ordered member slugs + a system prompt; getFleet reads them", () => {
  const f = createFleet(db, {
    name: "Platform",
    projects: ["api", "web"],
    systemPrompt: "Keep the two repos in sync.",
  });
  expect(f.slug).toBe("platform");
  expect(f.projects).toEqual(["api", "web"]); // order preserved
  expect(getFleet(db, "platform")?.systemPrompt).toBe("Keep the two repos in sync.");
  expect(listFleets(db).map((x) => x.slug)).toContain("platform");
});

test("updateFleet changes the member set; order is honored", () => {
  const f = createFleet(db, { name: "F", projects: ["a"] });
  const updated = updateFleet(db, f.slug, { projects: ["b", "a", "c"] });
  expect(updated?.projects).toEqual(["b", "a", "c"]);
});

test("fleetMembers resolves slugs to projects in order, skipping unknown ones", () => {
  const api = createProject(db, { name: "API", rootPath: "/tmp/api" });
  const web = createProject(db, { name: "Web", rootPath: "/tmp/web" });
  const fleet = createFleet(db, { name: "Stack", projects: [web.slug, "ghost", api.slug] });
  const members = fleetMembers(db, fleet.slug);
  expect(members.map((m) => m.slug)).toEqual([web.slug, api.slug]); // ghost skipped, order kept
});
