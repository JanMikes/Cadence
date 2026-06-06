/**
 * Live smoke for the polling watcher's setInterval scheduler. Run with `bun`
 * (NOT `bun test` — its test-runner timers are unreliable under load). Creates a
 * throwaway ~/.cadence, starts the watcher, then writes/edits/deletes a task.md
 * and asserts the timer-driven scans reindex it. Exits 0 on success, 1 on failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrateDb, openDb } from "../db/client";
import { tasks } from "../db/schema";
import { bootstrap, writeTask } from "./store";
import { startWatcher } from "./watcher";

const home = mkdtempSync(join(tmpdir(), "cadence-watch-live-"));
process.env.CADENCE_HOME = home;
bootstrap();
const db = openDb(join(home, "cadence.db"));
migrateDb(db);

const handle = startWatcher(db, { intervalMs: 50 });
const id = crypto.randomUUID();
const title = () => db.select().from(tasks).where(eq(tasks.id, id)).get()?.title;

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return false;
}

writeTask({ id, title: "Live", status: "inbox" }, "body");
const created = await waitUntil(() => title() === "Live");
writeTask({ id, title: "Live edited", status: "ready" }, "body edited");
const edited = await waitUntil(() => title() === "Live edited");
rmSync(join(home, "tasks", id), { recursive: true, force: true });
const deleted = await waitUntil(() => title() === undefined);
const ok = created && edited && deleted;
console.log(`[watcher.live] created=${created} edited=${edited} deleted=${deleted}`);

handle.close();
rmSync(home, { recursive: true, force: true });
console.log(
  ok
    ? "[watcher.live] OK — timer-driven polling reindexed create/edit/delete"
    : "[watcher.live] FAILED",
);
process.exit(ok ? 0 : 1);
