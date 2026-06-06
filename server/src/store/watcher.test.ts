import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrateDb, openDb, type Db } from "../db/client";
import { searchTasks } from "../db/search";
import { tasks } from "../db/schema";
import { paths } from "./paths";
import { bootstrap, writeTask } from "./store";
import { classifyPath, dispatchChange, startWatcher } from "./watcher";

/** Fresh ~/.cadence + migrated db; returns a teardown that also clears the env. */
function setup(prefix: string): { db: Db; home: string; teardown: () => void } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.CADENCE_HOME = home;
  bootstrap();
  const db = openDb(join(home, "cadence.db"));
  migrateDb(db);
  return {
    db,
    home,
    teardown: () => {
      delete process.env.CADENCE_HOME;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("classifyPath routes task/project/fleet markdown", () => {
  expect(classifyPath("tasks/abc/task.md")).toEqual({ kind: "task", key: "abc" });
  expect(classifyPath("projects/acme.md")).toEqual({ kind: "project", key: "acme" });
  expect(classifyPath("fleets/web.md")).toEqual({ kind: "fleet", key: "web" });
  expect(classifyPath("tasks/abc/context.md").kind).toBe("ignored");
  expect(classifyPath("settings.json").kind).toBe("ignored");
});

test("dispatchChange reindexes on write and removes on delete (deterministic)", () => {
  const { db, teardown } = setup("cadence-watch-d-");
  try {
    const id = crypto.randomUUID();
    writeTask({ id, title: "Dispatch me", status: "inbox" }, "find this needle");
    dispatchChange(db, `tasks/${id}/task.md`);
    expect(db.select().from(tasks).where(eq(tasks.id, id)).get()?.title).toBe("Dispatch me");
    expect(searchTasks(db, "needle").map((h) => h.taskId)).toContain(id);

    rmSync(paths.taskDir(id), { recursive: true, force: true });
    dispatchChange(db, `tasks/${id}/task.md`); // file gone -> row removed
    expect(db.select().from(tasks).where(eq(tasks.id, id)).get()).toBeUndefined();
    expect(searchTasks(db, "needle")).toHaveLength(0);
  } finally {
    teardown();
  }
});

// The watcher's real work is scan() (snapshot mtimes -> diff -> reindex/remove).
// We drive it directly so the test is deterministic; the setInterval(scan, …)
// scheduler is a trivial wrapper, smoke-tested live in watcher.live.ts.
test("watcher scan reindexes a task.md on create, edit, and delete (+FTS)", () => {
  const { db, teardown } = setup("cadence-watch-w-");
  const handle = startWatcher(db, { intervalMs: 60_000 });
  const id = crypto.randomUUID();
  const taskTitle = () => db.select().from(tasks).where(eq(tasks.id, id)).get()?.title;
  try {
    writeTask({ id, title: "Watched", status: "inbox" }, "body one");
    handle.scan();
    expect(taskTitle()).toBe("Watched");

    writeTask({ id, title: "Watched edited", status: "ready" }, "body two zephyr");
    handle.scan();
    expect(taskTitle()).toBe("Watched edited");
    expect(db.select().from(tasks).where(eq(tasks.id, id)).get()?.status).toBe("ready");
    expect(searchTasks(db, "zephyr").map((h) => h.taskId)).toContain(id);

    rmSync(paths.taskDir(id), { recursive: true, force: true });
    handle.scan();
    expect(taskTitle()).toBeUndefined();
    expect(searchTasks(db, "zephyr")).toHaveLength(0);
  } finally {
    handle.close();
    teardown();
  }
});
