import type { SelfMonitor } from "@cadence/shared";
import { existsSync, readdirSync } from "node:fs";
import type { Db } from "./db/client";
import { suggestions } from "./db/schema";
import { paths } from "./store/paths";
import { readDigest, readVerify } from "./store/store";
import { runSweep } from "./sweep";
import { listTasks } from "./tasks";

/**
 * Self-monitoring (spec §8.1): aggregate the raw learning signals — suggestion
 * provenance (what I accept vs correct), verify pass-rate, rollovers, and current
 * staleness. Pure read; this is the data the Reflector (5.2) distills from.
 */
export function computeSelfMonitor(db: Db, now: number = Date.now()): SelfMonitor {
  const provenance = { suggested: 0, confirmed: 0, edited: 0, overridden: 0, dismissed: 0 };
  for (const s of db.select({ status: suggestions.status }).from(suggestions).all()) {
    if (s.status in provenance) provenance[s.status as keyof typeof provenance]++;
  }
  const resolved = provenance.confirmed + provenance.edited + provenance.overridden + provenance.dismissed;
  const acceptanceRate = resolved > 0 ? provenance.confirmed / resolved : null;

  // Verify pass-rate: scan each task's verify.md (the Verifier's recorded outcome).
  let passed = 0;
  let failed = 0;
  for (const t of listTasks(db)) {
    const v = readVerify(t.id);
    if (!v) continue;
    if (v.passed) passed++;
    else failed++;
  }
  const passRate = passed + failed > 0 ? passed / (passed + failed) : null;

  // Rollovers: sum across every evening recap on disk.
  let rollovers = 0;
  const dir = paths.digestsDir();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const d = readDigest(f.replace(/\.md$/, ""));
      rollovers += d?.recap?.rolledOver.length ?? 0;
    }
  }

  const staleTasks = runSweep(db, now).findings.filter((x) => x.kind === "stale").length;

  return { provenance, acceptanceRate, verify: { passed, failed, passRate }, rollovers, staleTasks };
}
