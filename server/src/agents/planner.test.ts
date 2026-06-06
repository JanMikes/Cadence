import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "../db/client";
import { readPlan } from "../store/store";
import { bootstrap } from "../store/store";
import { createTask } from "../tasks";
import { applyPlan, approvePlan, buildPlannerPrompt, normalizeSteps, runPlanner } from "./planner";
import type { AgentResult } from "@cadence/shared";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-planner-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("buildPlannerPrompt includes the spec and forbids writing code", () => {
  const p = buildPlannerPrompt({ title: "Add login", body: "" }, "SPEC: support OAuth");
  expect(p).toContain("DO NOT WRITE CODE");
  expect(p).toContain("support OAuth");
});

test("normalizeSteps drops empty titles and omits undefined optional keys", () => {
  const steps = normalizeSteps({
    steps: [
      { title: "Step one", detail: "do it", files: ["a.ts"], risky: true },
      { title: "  ", detail: "skip me" }, // empty title → dropped
      { title: "Step two" }, // no optionals
    ],
  });
  expect(steps).toHaveLength(2);
  expect(steps[0]).toEqual({ title: "Step one", detail: "do it", files: ["a.ts"], risky: true });
  expect(steps[1]).toEqual({ title: "Step two" }); // no undefined keys
});

test("applyPlan writes an unapproved plan; approvePlan flips it", () => {
  const task = createTask(db, { title: "Plan me" });
  applyPlan(task.id, { steps: [{ title: "First" }, { title: "Second" }], notes: "be careful" });

  const plan = readPlan(task.id);
  expect(plan.approved).toBe(false);
  expect(plan.steps.map((s) => s.title)).toEqual(["First", "Second"]);
  expect(plan.notes).toBe("be careful");

  const approved = approvePlan(task.id);
  expect(approved.approved).toBe(true);
  expect(readPlan(task.id).approved).toBe(true);
  expect(readPlan(task.id).steps).toHaveLength(2); // steps preserved
});

test("runPlanner uses the injected runner and writes plan.md", async () => {
  const task = createTask(db, { title: "Run the planner" });
  const mock = async (): Promise<AgentResult> => ({
    text: "{}",
    json: { steps: [{ title: "Wire it up", files: ["x.ts"] }], notes: null },
    costUsd: 0,
    sessionId: "mock",
    isError: false,
    raw: {},
  });
  const outcome = await runPlanner(db, task.id, mock);
  expect(outcome).toEqual({ ran: true, steps: 1 });
  expect(readPlan(task.id).steps[0]?.title).toBe("Wire it up");
});
