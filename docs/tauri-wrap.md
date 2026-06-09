# Cadence — Tauri Desktop Wrap

> The native macOS shell for Cadence. It's a **wrap, not a rewrite**: a thin Rust (Tauri) shell
> supervises the existing Bun gateway as a self-contained sidecar and hosts the **unchanged** web UI in
> a webview pointed at the gateway's own `http://localhost:<port>` origin. The same web build runs in a
> plain browser tab *and* inside `Cadence.app` — every native bridge is feature-detected
> (`window.__TAURI__`), so the browser experience is identical.

Built as backlog **4.7**; the staged build ledger is [`tauri-build-plan.md`](tauri-build-plan.md).

## Architecture

```
┌─ Cadence.app  (Tauri / Rust = thin native shell) ───────────────┐
│  supervises the sidecar · reads its stdout for the bound URL ·   │
│  kills it on quit (RunEvent + SIGTERM/SIGINT) · Tray · global    │
│  hotkey · single-instance · autostart · native notifications     │
│   main WebviewWindow ── loads ──▶ http://localhost:<port>        │
│            ▲  same-origin /api + /ws  (SPA untouched)            │
│   ┌────────┴── sidecar: cadence-server  (bun build --compile) ──┐│
│   │  Bun.serve: REST /api · WS /ws · serves web/dist            ││
│   │  bun:sqlite + Drizzle · file watcher · spawns claude/git    ││
│   └───────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

- **Port discovery is free.** The shell spawns the sidecar with `CADENCE_PORT=0` (ephemeral); the
  gateway prints `[cadence] gateway listening on http://localhost:<port>` and writes
  `$CADENCE_HOME/runtime.json` (`{ port, url, pid }`). Rust scrapes the URL from stdout and navigates
  the (initially hidden) window to it; `runtime.json` lets tooling/smokes find the port too.
- **Relocatable gateway.** The compiled sidecar serves assets + migrations from Tauri bundle resources
  via `CADENCE_WEB_DIR` / `CADENCE_MIGRATIONS_DIR` (no source-relative paths). Set by the supervisor.
- **Self-contained sidecar.** `bun build --compile` embeds the Bun runtime, so `bun:sqlite` works on a
  machine with no Bun installed. (`pkg`/`nexe` target Node and can't run `bun:sqlite` — don't use them.)
- **No frontend rework.** The web client already uses same-origin relative URLs (`fetch("/api/…")`,
  `ws://${location.host}/ws`).

## Prerequisites

- **Bun** (the repo's runtime).
- **Rust toolchain** — `rustc`/`cargo` (install via [rustup](https://rustup.rs)).
- **Tauri CLI** — installed as a dev dependency (`@tauri-apps/cli`); run via `bun x tauri …`.
- **Xcode Command Line Tools** — `xcode-select --install` (almost always already present if `git` works).

## Scripts

| Script | What it does |
|---|---|
| `bun run tauri:dev` | Dev: runs the web (Vite) + gateway via `beforeDevCommand`, opens the window at `devUrl`. |
| `bun run tauri:build` | Release: web build + `sidecar:build`, compiles the Rust shell, bundles `Cadence.app` + `.dmg`. |
| `bun run sidecar:build` | Compiles `server/src/index.ts` → `src-tauri/binaries/cadence-server-<triple>` and stages `web/dist` + `server/drizzle` as `src-tauri/resources/`. |
| `bun run sidecar:smoke` | Runs the compiled sidecar on a tmp home (`CADENCE_PORT=0`), asserts `/api/health` + DB created. |
| `bun run app:smoke` | Launches the built `.app`, asserts health + exactly one `cadence-server`, single-instance (2nd launch → still one), clean shutdown (no orphan), and autostart (LaunchAgent plist appears on enable / disappears on disable). |

## Dev workflow

```bash
bun run tauri:dev
```

This runs `bun run dev` (gateway + Vite) and opens the window at `http://localhost:5173`. Hot reload
applies to the web UI; Rust changes trigger a recompile.

## Build a release bundle

```bash
bun run tauri:build
# → src-tauri/target/release/bundle/macos/Cadence.app
# → src-tauri/target/release/bundle/dmg/Cadence_<version>_aarch64.dmg
```

`beforeBuildCommand` runs the web build + `sidecar:build` first, so a one-shot `tauri:build` is enough.
Verify the bundle end-to-end with `bun run app:smoke`.

## Native shell features

- **Tray / menubar** — Open Cadence · Quick capture · Today · Inbox · — · Quit. Left-click shows/focuses
  the window; Quit ends the app and its sidecar.
- **Global hotkey** — `CmdOrCtrl+Shift+Space` brings Cadence forward and opens quick-capture (emits a
  `quick-capture` event; the web `useTauriBridge` opens the Add-task modal).
- **Native notifications** — `needs_feedback` / `delivered` events raise real macOS banners
  (`@tauri-apps/plugin-notification`); a plain browser falls back to Web Notifications.
- **Single-instance** — a 2nd launch focuses the running window instead of starting a duplicate.
- **Autostart** — "Launch at login" toggle in Settings (writes a `~/Library/LaunchAgents/Cadence.plist`).

## PATH & `claude` resolution

macOS apps launched from Finder don't inherit the shell `PATH`, so the sidecar wouldn't find `claude`
(usually `~/.local/bin`) or maybe `git`. The shell recovers it by running the login shell
(`$SHELL -lic 'printf … "$PATH"'`, banner-safe) and passing it to the sidecar; it falls back to
`/usr/bin:/bin:/usr/local/bin:$HOME/.local/bin`. You can also set an explicit **Claude binary path** in
Settings (exported as `CADENCE_CLAUDE_BIN`).

## Verification model (macOS-honest)

WebDriver E2E is Windows/Linux only — **macOS has no WKWebView driver** — so the webview/tray/hotkey
can't be driven by an automated test. We compensate with three cross-platform layers and defer only the
irreducible visual checks:

1. **`bun test`** — all TS logic (gateway env overrides, `runtime.json`, the feature-detected web bridges).
2. **`cargo test`** (`tauri::test` mock runtime) — supervisor pure fns (stdout→URL parse, env map,
   dev/prod branch, PATH resolver), the tray item-ids, and `global_shortcut().is_registered(...)`.
3. **Process / HTTP / filesystem smokes** — `sidecar:smoke` + `app:smoke`.

Two OS-bound checks can't run off the main thread in the test harness and are asserted structurally
instead (the live behaviour is in the §Visual checklist): building a `muda::Menu` (macOS main-thread
only) and the live tray. See the §Visual smoke checklist in [`tauri-build-plan.md`](tauri-build-plan.md).

## Code signing & notarization

Unsigned is **fine for personal, local use** — you build and run it on your own machine (locally built
apps aren't quarantined, so `open Cadence.app` won't hit Gatekeeper). To distribute it:

- **Sign:** set a Developer ID identity and `tauri build` signs the `.app`/`.dmg` (configure
  `bundle.macOS.signingIdentity` or the `APPLE_SIGNING_IDENTITY` env var).
- **Notarize:** submit to Apple (`xcrun notarytool`) with an Apple ID + app-specific password (or API
  key), then `xcrun stapler staple`. See the Tauri macOS code-signing guide.

Never commit signing identities/certificates — the repo is public-safe (see [SECURITY.md](../SECURITY.md)).

## Security

All runtime data lives in `~/.cadence/` (and `~/.claude/`), never the repo. Build artifacts
(`src-tauri/{target,binaries,resources,gen}/`) are git-ignored; `src-tauri/Cargo.lock` is tracked.
