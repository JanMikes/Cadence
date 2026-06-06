import type { AgentResult } from "@cadence/shared";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, openDb, type Db } from "../db/client";
import { bootstrap, readContext, readQa } from "../store/store";
import { createTask, getTask } from "../tasks";
import { answerQuestions, runQuestioner } from "./questioner";
import type { AgentRunner } from "./triage";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-qa-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function runner(json: object): AgentRunner {
  return async (): Promise<AgentResult> => ({
    text: JSON.stringify(json),
    json,
    costUsd: 0.001,
    sessionId: "mock",
    isError: false,
    raw: {},
  });
}

test("questioner writes ranked Q&A cards to qa.md → Needs-Feedback", async () => {
  const task = createTask(db, { title: "Add auth" });
  const outcome = await runQuestioner(
    db,
    task.id,
    runner({
      questions: [
        { id: "q1", rank: 1, type: "single_choice", text: "Which provider?", options: ["OAuth", "magic link"], why: "drives the flow" },
        { rank: 2, type: "boolean", text: "Do we need 2FA?" },
        { text: "" }, // dropped (no text)
      ],
    }),
  );

  expect(outcome).toMatchObject({ ran: true, status: "needs_feedback" });
  expect(getTask(db, task.id)?.status).toBe("needs_feedback");
  const qa = readQa(task.id);
  expect(qa.questions).toHaveLength(2);
  expect(qa.questions[0]).toMatchObject({ id: "q1", type: "single_choice", text: "Which provider?" });
  expect(qa.questions[1]?.id).toBe("q2"); // id defaulted
});

test("questioner with no questions → Ready", async () => {
  const task = createTask(db, { title: "Trivial task" });
  const outcome = await runQuestioner(db, task.id, runner({ questions: [] }));
  expect(outcome).toMatchObject({ ran: true, status: "ready" });
});

test("answering all questions advances Needs-Feedback → Ready and records answers in context", async () => {
  const task = createTask(db, { title: "Add auth" });
  await runQuestioner(
    db,
    task.id,
    runner({
      questions: [
        { id: "q1", rank: 1, type: "single_choice", text: "Which provider?", options: ["OAuth", "magic link"] },
        { id: "q2", rank: 2, type: "boolean", text: "Need 2FA?" },
      ],
    }),
  );

  // partial answer → stays in Needs-Feedback
  expect(answerQuestions(db, task.id, { q1: "OAuth" }).status).toBe("needs_feedback");

  // answer the rest → Ready
  expect(answerQuestions(db, task.id, { q2: "yes" }).status).toBe("ready");
  expect(getTask(db, task.id)?.status).toBe("ready");
  expect(readQa(task.id).answers).toMatchObject({ q1: "OAuth", q2: "yes" });
  expect(readContext(task.id)).toContain("A: OAuth");
});
