import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrateDb, openDb } from "./db/client";
import { sessions } from "./db/schema";
import { bootstrap } from "./store/store";
import { createTask } from "./tasks";
import { searchTranscripts } from "./transcript-search";

let db: Db;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cadence-tsearch-"));
  process.env.CADENCE_HOME = home;
  bootstrap();
  db = openDb(join(home, "cadence.db"));
  migrateDb(db);
});

afterEach(() => {
  delete process.env.CADENCE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function writeTranscript(lines: object[]): string {
  const path = join(home, `${crypto.randomUUID()}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

test("searchTranscripts finds a session by transcript content + returns a snippet", () => {
  const task = createTask(db, { title: "Auth work" });
  const path = writeTranscript([
    { type: "user", message: { role: "user", content: "please wire up the elasticsearch index" } },
    { type: "assistant", message: { role: "assistant", content: "done, indexed the documents" } },
  ]);
  db.insert(sessions)
    .values({ id: "sess-1", role: "chat", cwd: "/tmp", taskId: task.id, transcriptPath: path })
    .run();

  const hits = searchTranscripts(db, "elasticsearch");
  expect(hits).toHaveLength(1);
  expect(hits[0]?.sessionId).toBe("sess-1");
  expect(hits[0]?.taskId).toBe(task.id);
  expect(hits[0]?.snippet.toLowerCase()).toContain("elasticsearch");
});

test("searchTranscripts ignores non-matching sessions + empty queries", () => {
  const path = writeTranscript([{ type: "assistant", message: { role: "assistant", content: "nothing here" } }]);
  db.insert(sessions).values({ id: "s2", role: "chat", cwd: "/tmp", transcriptPath: path }).run();
  expect(searchTranscripts(db, "kubernetes")).toHaveLength(0);
  expect(searchTranscripts(db, "   ")).toHaveLength(0);
});
