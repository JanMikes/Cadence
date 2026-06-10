import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRegistry } from "../approvals";
import { type Db, migrateDb, openDb } from "../db/client";
import { bootstrap, readContext, readQa } from "../store/store";
import { createTask } from "../tasks";
import type { WsHub } from "../ws";
import { makeAskGate } from "./ask-gate";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-gate-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function stubHub(): { hub: WsHub; broadcasts: Array<{ name: string; payload?: unknown }> } {
  const broadcasts: Array<{ name: string; payload?: unknown }> = [];
  return {
    hub: { broadcast: (m: { name: string; payload?: unknown }) => broadcasts.push(m) } as unknown as WsHub,
    broadcasts,
  };
}

const QUESTIONS_INPUT = {
  questions: [
    {
      question: "Where should the button live?",
      header: "Placement",
      multiSelect: false,
      options: [{ label: "Task detail" }, { label: "Board card" }],
    },
  ],
};

async function waitForParked(approvals: ApprovalRegistry): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const list = approvals.list();
    if (list.length > 0) return list[0]?.id ?? "";
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("nothing got parked");
}

test("askQuestions: the user's answer flows back into the run AND onto the task record", async () => {
  const { hub, broadcasts } = stubHub();
  const approvals = new ApprovalRegistry();
  const t = createTask(db, { title: "live ask" });
  const gate = makeAskGate({ approvals, hub, db, waitMsOverride: 5_000 });

  const pending = gate.askQuestions(QUESTIONS_INPUT, { taskId: t.id, role: "planner" });
  const id = await waitForParked(approvals);
  expect(gate.pendingCount()).toBe(1);
  // The user is notified that a live run paused for them.
  const notify = broadcasts.find((b) => b.name === "notify");
  expect((notify?.payload as { title: string }).title).toContain("Planner");

  approvals.resolve(id, { allow: true, answers: { "Where should the button live?": "Board card" } });
  const answers = await pending;
  expect(answers).toEqual({ "Where should the button live?": "Board card" });
  expect(gate.pendingCount()).toBe(0);

  // The live exchange is durable: Q&A channel answered + context note.
  const qa = readQa(t.id);
  expect(qa.questions).toHaveLength(1);
  expect(Object.values(qa.answers)).toContain("Board card");
  expect(readContext(t.id)).toContain("A: Board card");
});

test("askQuestions: timeout → null, and the parked card is withdrawn (no stale ask in the UI)", async () => {
  const { hub } = stubHub();
  const approvals = new ApprovalRegistry();
  const gate = makeAskGate({ approvals, hub, db, waitMsOverride: 30 });

  const answers = await gate.askQuestions(QUESTIONS_INPUT, { role: "discovery" });
  expect(answers).toBeNull();
  expect(approvals.list()).toHaveLength(0);
});

test("askQuestions: an aborted run (stop) releases the wait immediately", async () => {
  const { hub } = stubHub();
  const approvals = new ApprovalRegistry();
  const gate = makeAskGate({ approvals, hub, db, waitMsOverride: 60_000 });
  const abort = new AbortController();

  const pending = gate.askQuestions(QUESTIONS_INPUT, { role: "planner", signal: abort.signal });
  await waitForParked(approvals);
  abort.abort();
  expect(await pending).toBeNull();
  expect(approvals.list()).toHaveLength(0);
});

test("approveTool: allow and deny round-trips (Manual mode)", async () => {
  const { hub } = stubHub();
  const approvals = new ApprovalRegistry();
  const gate = makeAskGate({ approvals, hub, db, waitMsOverride: 5_000 });

  const p1 = gate.approveTool("Bash", { command: "bun test" }, { role: "implementer" });
  approvals.resolve(await waitForParked(approvals), { allow: true });
  expect(await p1).toBe(true);

  const p2 = gate.approveTool("Bash", { command: "rm -rf /" }, { role: "implementer" });
  approvals.resolve(await waitForParked(approvals), { allow: false });
  expect(await p2).toBe(false);
});
