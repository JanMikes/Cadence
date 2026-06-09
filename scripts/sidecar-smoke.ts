/**
 * Smoke-test the compiled sidecar end-to-end — the cheapest proof that the standalone
 * `bun build --compile` binary actually runs: it boots, opens bun:sqlite, applies the bundled
 * drizzle migrations, serves the bundled web assets, and answers HTTP — all with NO Bun installed
 * in its environment (it embeds the runtime). Retires the bun:sqlite / static-serving packaging risk.
 *
 * Runs the binary with CADENCE_PORT=0 (ephemeral) + a fresh tmp CADENCE_HOME, pointing
 * CADENCE_WEB_DIR / CADENCE_MIGRATIONS_DIR at the staged Tauri resources, discovers the bound URL via
 * runtime.json, asserts GET /api/health is ok + index.html is served + cadence.db was created, then
 * kills the child and cleans up. Exits 0 on success, non-zero on any failure. Re-runnable.
 *
 * Prereq: `bun run --filter @cadence/web build` && `bun run sidecar:build`.
 * Run via the root script: `bun run sidecar:smoke`.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const binDir = join(root, "src-tauri", "binaries");
const resources = join(root, "src-tauri", "resources");
const webDir = join(resources, "web");
const migrationsDir = join(resources, "drizzle");

function findBinary(): string {
  if (!existsSync(binDir)) throw new Error(`no ${binDir} — run \`bun run sidecar:build\` first`);
  const hits = readdirSync(binDir).filter(
    (f) => f.startsWith("cadence-server-") && !f.endsWith(".map") && !f.endsWith(".sym"),
  );
  if (hits.length === 0) throw new Error(`no cadence-server-* binary in ${binDir} — run \`bun run sidecar:build\``);
  return join(binDir, hits[0]!);
}

const binary = findBinary();
for (const [label, p] of [["web resources", webDir], ["drizzle resources", migrationsDir]] as const) {
  if (!existsSync(p)) throw new Error(`missing ${label}: ${p} — run \`bun run sidecar:build\``);
}

const home = mkdtempSync(join(tmpdir(), "cadence-sidecar-smoke-"));
console.log(`[sidecar-smoke] launching ${binary}`);
console.log(`[sidecar-smoke] home=${home}`);

const child = Bun.spawn([binary], {
  env: {
    ...process.env,
    CADENCE_PORT: "0", // ephemeral — proves the runtime.json discovery path
    CADENCE_HOME: home,
    CADENCE_WEB_DIR: webDir,
    CADENCE_MIGRATIONS_DIR: migrationsDir,
  },
  stdout: "inherit", // surface the gateway's "[cadence] gateway listening on …" line
  stderr: "inherit",
});

/** Wait for the gateway to write runtime.json (written right after it binds the port). */
async function waitForRuntime(timeoutMs = 20_000): Promise<{ port: number; url: string }> {
  const rt = join(home, "runtime.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`sidecar exited early (code ${child.exitCode})`);
    if (existsSync(rt)) {
      try {
        const info = JSON.parse(await Bun.file(rt).text()) as { port: number; url: string };
        if (info?.url) return info;
      } catch {
        // file caught mid-write — retry
      }
    }
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for runtime.json (sidecar never reported a bound port)");
}

let ok = false;
try {
  const { url } = await waitForRuntime();
  console.log(`[sidecar-smoke] gateway up at ${url}`);

  const health = (await fetch(`${url}/api/health`).then((r) => r.json())) as { ok?: boolean; app?: string };
  if (!health.ok) throw new Error(`/api/health did not return ok: ${JSON.stringify(health)}`);

  const html = (await fetch(`${url}/`).then((r) => r.text())).toLowerCase();
  if (!html.includes("<!doctype html")) throw new Error("index.html was not served from the bundled web resources");

  const dbPath = join(home, "cadence.db");
  if (!existsSync(dbPath)) throw new Error(`bun:sqlite DB was not created at ${dbPath}`);

  console.log(`[sidecar-smoke] OK — health ok (${health.app}), index.html served, DB created at ${dbPath}`);
  ok = true;
} finally {
  child.kill();
  await child.exited;
  rmSync(home, { recursive: true, force: true });
}

if (!ok) process.exit(1);
console.log("[sidecar-smoke] PASS");
