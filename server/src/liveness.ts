import { execFileSync } from "node:child_process";

/**
 * Honest process liveness (plan §6.1.d) — the single source of truth for "is this
 * run's process actually alive?". Born from the 17-zombie incident, where
 * `process.kill(pid, 0)` alone kept dead runs "running" for 15+ hours:
 *
 *   - a DEFUNCT (zombie, "Z…") process passes kill(0) until its parent reaps it;
 *   - after days of uptime macOS recycles pids, so a recorded pid can point at a
 *     completely unrelated process (which also passes kill(0)).
 *
 * The fix: liveness = pid exists AND is not defunct AND its start time (now − etime)
 * matches the session row's startedAt within a tolerance. Start-time matching is the
 * process *signature* — it defeats pid reuse without caring what binary the run used
 * (claude, a custom CADENCE_CLAUDE_BIN, or a bun mock in tests).
 */

/** Whether `pid` is a live process per kill(0). Treats EPERM (exists, not ours) as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface ProcInfo {
  /** ps state, e.g. "S+", "R", "Z" (defunct). */
  stat: string;
  /** Seconds since the process started (from ps etime). */
  etimeSec: number;
  /** The command line — diagnostics only, not used for the liveness verdict. */
  command: string;
}

/** Parse ps etime ("[[dd-]hh:]mm:ss") into seconds; null when unparseable. */
export function parseEtime(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (
    Number(dd ?? 0) * 86_400 + Number(hh ?? 0) * 3_600 + Number(mm) * 60 + Number(ss)
  );
}

/** One `ps` round-trip for stat+etime+command; null when the pid is gone. */
export function probeProc(pid: number): ProcInfo | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "stat=,etime=,command="], {
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    const m = out.match(/^(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    return { stat: m[1] as string, etimeSec: parseEtime(m[2] as string) ?? 0, command: m[3] ?? "" };
  } catch {
    return null;
  }
}

/** Probes, injectable for deterministic tests. */
export interface LivenessProbe {
  alive: (pid: number) => boolean;
  proc: (pid: number) => ProcInfo | null;
  now: () => number;
}

export const REAL_PROBE: LivenessProbe = { alive: isProcessAlive, proc: probeProc, now: Date.now };

/**
 * |process start − row start| tolerance for the signature match. Real drift is
 * milliseconds (row insert → spawn); minutes apart means a recycled pid.
 */
export const START_TOLERANCE_MS = 120_000;

/**
 * The recording runner inserts the session row BEFORE the child reports its pid, so a
 * legitimately-starting run briefly has pid=null. Such rows count as live while young;
 * older ones never got a process (the gateway died between insert and spawn).
 */
export const PRE_SPAWN_GRACE_MS = 30_000;

/** Honest pid-level liveness: exists, not defunct, and start-time signature matches. */
export function isRunPidAlive(
  pid: number,
  startedAt: number | null | undefined,
  probe: LivenessProbe = REAL_PROBE,
): boolean {
  if (!probe.alive(pid)) return false;
  const info = probe.proc(pid);
  if (!info) return false;
  if (info.stat.trim().toUpperCase().startsWith("Z")) return false; // defunct = dead
  if (startedAt != null && startedAt > 0) {
    const processStart = probe.now() - info.etimeSec * 1000;
    // etime has 1s granularity; allow the tolerance on top of it.
    if (Math.abs(processStart - startedAt) > START_TOLERANCE_MS + 1000) return false; // pid reuse
  }
  return true;
}

/**
 * Honest liveness for a session row (the shared verdict used by the stage-spawn
 * dedupe guard, the watchdog sweep, startup reconcile and the sessions UI).
 */
export function isSessionRowAlive(
  row: { pid: number | null; startedAt: number | null },
  probe: LivenessProbe = REAL_PROBE,
): boolean {
  if (row.pid != null) return isRunPidAlive(row.pid, row.startedAt, probe);
  return probe.now() - (row.startedAt ?? 0) < PRE_SPAWN_GRACE_MS;
}
