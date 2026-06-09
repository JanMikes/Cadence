/**
 * Build the self-contained Cadence gateway sidecar for the Tauri bundle.
 *
 * Tauri's backend is Rust, so it supervises our Bun gateway as an external binary ("sidecar").
 * `bun build --compile` produces a standalone executable that embeds the Bun runtime — so it runs
 * on a machine without Bun installed and keeps `bun:sqlite` working (unlike pkg/nexe, which target
 * Node). Tauri resolves a sidecar by the Rust *target triple* suffix (`cadence-server-<triple>`),
 * so we name the output to match `bundle.externalBin = ["binaries/cadence-server"]`.
 *
 * Steps: resolve the host triple (rustc) → map to a Bun compile target → compile the gateway entry →
 * stage `web/dist` and `server/drizzle` as Tauri resources (served via CADENCE_WEB_DIR /
 * CADENCE_MIGRATIONS_DIR at runtime). Requires the web app to be built first (`bun run --filter
 * @cadence/web build`); throws a clear error otherwise. Outputs land under src-tauri/ (gitignored).
 *
 * Run via the root script: `bun run sidecar:build`.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

/** Resolve the Rust host target triple (e.g. "aarch64-apple-darwin"). rustc may not be on PATH for
 *  a GUI/`bun run` invocation, so also try the rustup default location. */
function rustHostTriple(): string {
  const candidates = ["rustc", join(homedir(), ".cargo", "bin", "rustc")];
  for (const bin of candidates) {
    try {
      const printed = Bun.spawnSync([bin, "--print", "host-tuple"], { stdout: "pipe", stderr: "pipe" });
      if (printed.exitCode === 0) {
        const t = printed.stdout.toString().trim();
        if (t) return t;
      }
      // Older rustc lacks `--print host-tuple`; parse the verbose version banner instead.
      const verbose = Bun.spawnSync([bin, "-vV"], { stdout: "pipe", stderr: "pipe" });
      if (verbose.exitCode === 0) {
        const m = verbose.stdout.toString().match(/^host:\s*(.+)$/m);
        if (m?.[1]) return m[1].trim();
      }
    } catch {
      // try the next candidate path
    }
  }
  throw new Error(
    "could not determine the Rust host triple — is the Rust toolchain installed? " +
      "(rustc not found on PATH or in ~/.cargo/bin; run docs/tauri-build-plan.md step 0.1)",
  );
}

/** Map a Rust host triple to the matching `bun build --compile` target. */
function bunTarget(triple: string): string {
  const arch = triple.includes("aarch64") || triple.includes("arm64") ? "arm64" : "x64";
  if (triple.includes("apple-darwin")) return `bun-darwin-${arch}`;
  if (triple.includes("linux")) return `bun-linux-${arch}`;
  if (triple.includes("windows")) return `bun-windows-${arch}`;
  throw new Error(`unsupported host triple for the sidecar: ${triple}`);
}

/** Replace `dest` with a fresh recursive copy of `src` (fails loudly if `src` is missing). */
function stageDir(src: string, dest: string, hint: string): void {
  if (!existsSync(src)) throw new Error(`missing ${src} — ${hint}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

const triple = rustHostTriple();
const target = bunTarget(triple);
const binDir = join(root, "src-tauri", "binaries");
const outfile = join(binDir, `cadence-server-${triple}`);
mkdirSync(binDir, { recursive: true });

console.log(`[sidecar] host triple ${triple} → bun target ${target}`);
console.log(`[sidecar] compiling server/src/index.ts → ${outfile}`);
const build = Bun.spawnSync(
  [
    process.execPath,
    "build",
    join(root, "server", "src", "index.ts"),
    "--compile",
    "--minify",
    "--sourcemap",
    `--target=${target}`,
    "--outfile",
    outfile,
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) {
  console.error("[sidecar] `bun build --compile` failed");
  process.exit(build.exitCode ?? 1);
}

const resources = join(root, "src-tauri", "resources");
stageDir(join(root, "web", "dist"), join(resources, "web"), "build the web app first: bun run --filter @cadence/web build");
stageDir(join(root, "server", "drizzle"), join(resources, "drizzle"), "drizzle migrations missing from server/drizzle");

console.log(`[sidecar] staged resources: ${join(resources, "web")}, ${join(resources, "drizzle")}`);
console.log("[sidecar] done.");
