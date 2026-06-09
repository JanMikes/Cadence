/**
 * App-level smoke for the built Cadence.app — the macOS-honest integration test the build can run
 * itself (no WKWebView WebDriver on macOS). Proves the native shell: the supervisor spawns the
 * bundled gateway sidecar, wires the relocation env, serves the API, and — critically — leaves NO
 * orphaned cadence-server when the app terminates.
 *
 * Launches the app binary directly (for pid control), waits for the sidecar to publish a *fresh*
 * ~/.cadence/runtime.json (distinct from any already-running dev gateway), asserts GET /api/health +
 * exactly one more cadence-server than baseline, then SIGTERMs the app (its signal handler kills the
 * sidecar) and asserts the count returns to baseline with no orphan. Robust to a concurrently running
 * dev gateway: it counts by process name, uses baseline deltas, and restores that gateway's
 * runtime.json on the way out. Exits 0 on success, non-zero on any failure.
 *
 * Prereq: `bun x tauri build`. Run via the root script: `bun run app:smoke`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const appPath = join(root, "src-tauri", "target", "release", "bundle", "macos", "Cadence.app");
const appBin = join(appPath, "Contents", "MacOS", "app");
const runtimeFile = join(homedir(), ".cadence", "runtime.json");

if (!existsSync(appBin)) {
  console.error(`[app-smoke] no built app at ${appPath} — run \`bun x tauri build\` first`);
  process.exit(1);
}

type Runtime = { port: number; url: string; pid: number };

function readRuntime(): Runtime | null {
  try {
    return existsSync(runtimeFile) ? (JSON.parse(readFileSync(runtimeFile, "utf8")) as Runtime) : null;
  } catch {
    return null;
  }
}

/** Count running sidecars by exact process name — a `bun run dev` gateway is NOT a cadence-server. */
function countSidecars(): number {
  const r = Bun.spawnSync(["pgrep", "-x", "cadence-server"]);
  return r.stdout.toString().trim().split("\n").filter(Boolean).length;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const baseline = countSidecars();
const before = readRuntime(); // a running dev gateway's descriptor, if any — restored at the end

let child: Bun.Subprocess | undefined;
let sidecarPid: number | undefined;
let ok = false;

try {
  console.log(`[app-smoke] baseline cadence-server=${baseline}; launching ${appBin}`);
  child = Bun.spawn([appBin], { stdout: "inherit", stderr: "inherit" });

  // Wait for the bundled app's sidecar to publish a fresh runtime.json (different pid than any
  // pre-existing dev gateway) with a live pid.
  let rt: Runtime | null = null;
  const upDeadline = Date.now() + 30_000;
  while (Date.now() < upDeadline) {
    if (child.exitCode !== null) throw new Error(`app exited early (code ${child.exitCode})`);
    const cur = readRuntime();
    if (cur && cur.pid !== before?.pid && pidAlive(cur.pid)) {
      rt = cur;
      break;
    }
    await Bun.sleep(200);
  }
  if (!rt) throw new Error("app did not publish a fresh runtime.json with a live pid within 30s");
  sidecarPid = rt.pid;
  console.log(`[app-smoke] app up at ${rt.url} (sidecar pid ${rt.pid})`);

  const health = (await fetch(`${rt.url}/api/health`).then((r) => r.json())) as {
    ok?: boolean;
    app?: string;
  };
  if (!health.ok) throw new Error(`/api/health did not return ok: ${JSON.stringify(health)}`);

  const running = countSidecars();
  if (running !== baseline + 1) {
    throw new Error(`expected exactly ${baseline + 1} cadence-server, found ${running}`);
  }
  console.log(`[app-smoke] health ok (${health.app}); exactly one sidecar (count=${running})`);

  // Quit the app: SIGTERM → the supervisor's signal handler kills the sidecar, then exits.
  process.kill(child.pid as number, "SIGTERM");
  await child.exited;

  const quitDeadline = Date.now() + 15_000;
  while (Date.now() < quitDeadline && (countSidecars() > baseline || pidAlive(sidecarPid))) {
    await Bun.sleep(200);
  }
  const after = countSidecars();
  if (after !== baseline) throw new Error(`orphaned cadence-server after quit: count=${after} (baseline ${baseline})`);
  if (pidAlive(sidecarPid)) throw new Error(`sidecar pid ${sidecarPid} still alive after quit`);
  console.log("[app-smoke] clean shutdown — no orphaned cadence-server");
  ok = true;
} finally {
  // Never leave the app or its sidecar running.
  try {
    if (child?.pid && pidAlive(child.pid)) process.kill(child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  if (sidecarPid && pidAlive(sidecarPid)) {
    try {
      process.kill(sidecarPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await Bun.sleep(300);
  // Tidy ~/.cadence/runtime.json: restore a still-running dev gateway's descriptor, else drop a stale one.
  const now = readRuntime();
  if (before && pidAlive(before.pid)) {
    writeFileSync(runtimeFile, `${JSON.stringify(before, null, 2)}\n`);
  } else if (now && !pidAlive(now.pid)) {
    rmSync(runtimeFile, { force: true });
  }
}

console.log(ok ? "[app-smoke] PASS" : "[app-smoke] FAIL");
process.exit(ok ? 0 : 1);
