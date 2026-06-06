import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "../db/client";
import { createProject } from "../projects";
import { bootstrap, readContext } from "../store/store";
import { createTask, getTask } from "../tasks";
import type { AgentRunner } from "./triage";
import { buildTriagePrompt, runTriage } from "./triage";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-triage-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** A mock agent runner that returns a fixed triage JSON as its result. */
function mockRunner(triage: object): AgentRunner {
  return async (): Promise<AgentResult> => ({
    text: JSON.stringify(triage),
    json: triage,
    costUsd: 0.0005,
    sessionId: "mock",
    isError: false,
    raw: { result: JSON.stringify(triage) },
  });
}

test("buildTriagePrompt includes the task + known projects", () => {
  const p = buildTriagePrompt({ title: "Fix login", body: "users locked out" }, [
    { slug: "acme", name: "Acme" },
  ]);
  expect(p).toContain("Fix login");
  expect(p).toContain("users locked out");
  expect(p).toContain("acme (Acme)");
});

test("a sufficient triage routes the task → Triaged with project/priority/deadline/labels", async () => {
  createProject(db, { name: "Acme", rootPath: "/tmp/acme" });
  const task = createTask(db, { title: "Fix the acme login bug" });

  const outcome = await runTriage(
    db,
    task.id,
    mockRunner({
      sufficiency: "ok",
      restatement: "Fix the broken Acme login flow",
      projectSlug: "acme",
      priority: "P1",
      deadline: "2026-07-15",
      labels: ["bug", "auth"],
    }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "triaged" });
  const t = getTask(db, task.id);
  expect(t?.status).toBe("triaged");
  expect(t?.priority).toBe("P1");
  expect(t?.projectId).toBeTruthy(); // slug resolved to FK id
  expect(t?.deadline).toBe(Date.parse("2026-07-15"));
  expect(readContext(task.id)).toContain("Triage restatement: Fix the broken Acme login flow");
});

test("an insufficient triage → Needs-Feedback with what's needed", async () => {
  const task = createTask(db, { title: "do the thing" });
  const outcome = await runTriage(
    db,
    task.id,
    mockRunner({ sufficiency: "insufficient", needFromUser: "Which project, and what 'thing'?" }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "needs_feedback" });
  expect(getTask(db, task.id)?.status).toBe("needs_feedback");
  expect(readContext(task.id)).toContain("Which project");
});

test("unparseable triage output leaves the task in Inbox", async () => {
  const task = createTask(db, { title: "x" });
  const runner: AgentRunner = async () => ({
    text: "sorry, not json",
    json: null,
    costUsd: 0,
    sessionId: null,
    isError: false,
    raw: {},
  });
  expect(await runTriage(db, task.id, runner)).toEqual({ ran: false });
  expect(getTask(db, task.id)?.status).toBe("inbox");
});
