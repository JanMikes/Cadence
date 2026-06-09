# Cadence — Tauri Wrap Build Plan & Progress Ledger

> **Staged, autonomous, self-healing ledger for the Tauri desktop wrap (backlog 4.7).** A `/loop` session
> reads this file (after `CLAUDE.md`, `docs/platform-definition.md`, `docs/build-plan.md`), reconciles it
> against the repo, then implements + verifies the next unchecked step — unattended, resumable from any
> point. The idempotent loop prompt is [`tauri-build-prompt.md`](tauri-build-prompt.md).
>
> Companion to [`build-plan.md`](build-plan.md) ("🎉 BUILD COMPLETE"); it re-opens the one deferred item,
> **4.7 Tauri wrap**, as its own loopable build. Step 6.2 flips 4.7 → done in the main ledger at the end.

## Why this is a wrap, not a rewrite
The backend is a **Bun** process (gateway: HTTP + WS + `bun:sqlite`/Drizzle + file watcher + it shells out
to `claude`/`git`). Tauri's backend is **Rust**, so Tauri *supervises the Bun gateway as a self-contained
sidecar* and hosts the **existing** web UI in a webview. The web client already uses **same-origin relative
URLs** (`fetch("/api/…")`, `ws://${location.host}/ws`), so pointing the webview at the gateway's own
`http://localhost:<port>` origin runs the SPA **unchanged** — "additive, zero rework" per the locked decision.

```
┌─ Cadence.app  (Tauri / Rust = thin native shell) ───────────────┐
│  supervises the sidecar · reads its stdout for the bound URL ·   │
│  kills it on quit · Tray · global hotkey · single-instance ·     │
│  autostart · native notifications                                │
│   main WebviewWindow ── loads ──▶ http://localhost:<port>        │
│            ▲  same-origin /api + /ws  (SPA untouched)            │
│   ┌────────┴── sidecar: cadence-server  (bun build --compile) ──┐│
│   │  Bun.serve: REST /api · WS /ws · serves web/dist            ││
│   │  bun:sqlite + Drizzle · file watcher · spawns claude/git    ││
│   └───────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```
Port discovery is free: spawn with `CADENCE_PORT=0` (the gateway already supports an ephemeral port and
prints `[cadence] gateway listening on <url>`); Rust reads that line, then navigates the window. The gateway
also writes the bound port to `$CADENCE_HOME/runtime.json` (step 1.3) so smokes can find it.

## Locked decisions (Jan, 2026-06-09)
- **Webview origin:** load the UI from the gateway's `http://localhost:<port>` (zero frontend rework).
- **Sidecar packaging:** self-contained `bun build --compile` (runs without Bun installed). *Not* `pkg`/`nexe`
  — those target the Node runtime and cannot run `bun:sqlite` (verified against Tauri's Node-sidecar guide).
- **Window model:** Dock + menubar (macOS `Regular` activation) **plus** a tray icon.
- **Scope:** full native shell in one pass (supervisor + tray + hotkey + notifications + single-instance + autostart).
- **Execution:** **autonomous** — the loop installs what it needs, drives every step, and self-verifies to
  the limit the platform allows; visual confirmation is deferred to a single non-blocking end checklist.

## Autonomy & verification model (READ THIS)
**Platform fact (Tauri docs):** WebDriver E2E is **Windows/Linux only — macOS has no WKWebView driver**. So
the webview/tray/hotkey/notification cannot be *driven* by an automated test on macOS. We compensate with
three cross-platform automated layers, and defer only the irreducible *visual* checks:

1. **`bun test`** — all TS logic (gateway env overrides, port file, settings, the feature-detected web bridges).
2. **`cargo test` (mock runtime, `tauri::test`)** — Rust setup logic *without* a window: sidecar command + env
   construction, stdout→URL parse (pure fn), `global_shortcut().is_registered(...)`, tray/menu build, plugin
   registration, PATH resolution, dev/prod URL branch.
3. **Process / HTTP / filesystem smokes** — `scripts/sidecar-smoke.ts` (`curl /api/health` + DB created from the
   standalone binary) and `scripts/app-smoke.ts` (launch the built `.app`, read `runtime.json`, curl health,
   assert exactly one `cadence-server`, quit, assert **no orphan**; relaunch → still one → single-instance;
   toggle autostart → assert the LaunchAgent plist appears/disappears).

**Verification tiers used by the steps:**
- `[auto]` — fully machine-verified by one of the three layers. The loop runs it and checks `[x]` on green.
- `[visual]` — code is implemented **and** machine-verified at the Rust/process/filesystem level, but a final
  human *visual/OS* confirmation is recommended. The loop checks `[x]` on the automated criteria and appends a
  line to **§ Visual smoke checklist** (non-blocking — the loop does NOT wait).

There are **no blocking gates**: the loop runs end-to-end. (Toolchain install is auto + idempotent; it stops
only if an install genuinely fails — recorded as a Blocker.)

## Self-healing / idempotent / resumable contract
- **Reality wins.** Each iteration re-derives state from `git log`, the filesystem, and by *re-running the
  cheap Verify checks* — never from blind trust in the checkboxes. If a `[x]` step no longer verifies
  (regression), un-check it and fix it before doing anything new.
- **Resume from anywhere.** Steps are atomic and committed only when green, so a fresh context reconstructs
  "where am I" from the last commit + which Verify lines currently pass. The first not-yet-passing step is next.
- **Crash-safe working tree.** On resume, if `git status` is dirty: leave PRE-EXISTING/unrelated changes
  entirely alone (never touch a file the current step didn't create); for an interrupted Tauri step only, if
  its changes form a *complete, verifying* step → finish-verify-commit it, else revert ONLY those specific
  files (scoped `git checkout -- <file>`) and redo. NEVER blanket `git clean -fd` / `git restore .`. Never commit a red step.
- **Bounded self-repair.** On a failed Verify, attempt up to **3** focused fixes (read the error, adjust, re-verify).
  If still red, write a precise Blocker entry (symptom, last error, hypotheses, exact next action) to the Journal,
  set the snapshot, and **stop cleanly**. Never thrash; never fake a pass; never check an unverified box.
- **Keep all gates green.** Any TS change keeps `bun test` + `bun run build` green; any Rust change keeps
  `cargo build` + `cargo test` green before commit.

## Status snapshot ← the loop keeps this current
- **Current stage:** Stage 2 — complete. Next: Stage 3 (Tauri scaffold + supervisor).
- **Last completed step:** 2.2 (sidecar smoke).
- **Next step:** 3.1 (scaffold `src-tauri/` + config).
- **Blockers:** none.
- **Last updated:** 2026-06-09 (Stage 2 done — sidecar smoke green, packaging risk retired).

## Rules for the loop (idempotent)
1. **Orient** — read `CLAUDE.md`, `docs/platform-definition.md`, `docs/build-plan.md`, and this file.
2. **Reconcile** — `git log --oneline -15`; check files; run the cheap Verify checks for recently-done steps
   (`bun test`, and if `src-tauri/` exists `cargo build`). Repo + history WIN; fix the ledger to match.
3. **Select** the FIRST unchecked (or regressed) step in the lowest incomplete stage (respect order + deps).
4. **Implement** ONE step; small focused diff matching repo conventions.
5. **Verify** per the step's *Verify* line + the relevant gates. `[auto]`: must pass. `[visual]`: pass the
   automated criteria, then append the visual item to § Visual smoke checklist.
6. **Commit** just that step: `build(4.7.<stage>.<step>): <summary>` (use `git commit -F` for messages with backticks).
7. **Record** — check the box, append a Progress Journal entry, update the Status snapshot.
8. **Continue** to the next step across stage boundaries. STOP only when: all stages done (say
   `🎉 TAURI WRAP COMPLETE`), or a Blocker after 3 repair attempts, or the toolchain truly can't be installed.

---

## Stage 0 — Prerequisites & re-open
- [x] **0.1 Ensure toolchain.** `[auto]` Idempotent: skip anything already present.
  - `rustc`/`cargo`: if absent, install non-interactively: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, then source `~/.cargo/env`.
  - Tauri CLI: `bun x tauri --version`; if absent, `bun add -d @tauri-apps/cli`.
  - Xcode CLT: `xcode-select -p`. If absent (rare — `git` works here, so it's present), record a Blocker with
    `xcode-select --install` (the only step that may need a human GUI click) and stop.
  - Verify: `rustc --version`, `cargo --version`, `bun x tauri --version` all report; `bun test` + `bun run build` green.
- [x] **0.2 Re-open 4.7 + wire ledgers.** `[auto]` In `docs/build-plan.md` flip 4.7 OUT-OF-SCOPE → in-progress
  (pointer to this file); set the related `docs/backlog.md` lines to `[~]`. Add to `.gitignore`:
  `src-tauri/target/`, `src-tauri/binaries/`, `src-tauri/resources/`, `src-tauri/gen/`. **Commit**
  `src-tauri/Cargo.lock` (it's an application binary — lockfile is tracked).
  - Verify: `git status` shows only intended edits; `bun test` + `bun run build` green.

**Stage 0 acceptance:** toolchain present; ledgers reconciled; gitignore covers build artifacts.

## Stage 1 — Relocatable gateway (pure TS — fully auto-verifiable; do FIRST to de-risk)
- [x] **1.1 `CADENCE_WEB_DIR` override.** `[auto]` `server/src/gateway.ts`: `webDir = opts.webDir ?? process.env.CADENCE_WEB_DIR ?? DEFAULT_WEB_DIR`.
  - Verify: `bun test` — a gateway with `CADENCE_WEB_DIR=<fixture>` serves the fixture `index.html`; existing tests green; `bun run build` green.
- [x] **1.2 `CADENCE_MIGRATIONS_DIR` override.** `[auto]` `server/src/db/client.ts`: `migrationsFolder` reads `process.env.CADENCE_MIGRATIONS_DIR ?? <relative default>`.
  - Verify: `bun test` — `openAndMigrate` on a temp DB with `CADENCE_MIGRATIONS_DIR=server/drizzle` creates all tables; existing migration tests green; `bun run build` green.
- [x] **1.3 Runtime port file.** `[auto]` On startup the gateway writes `{ "port": <n>, "url": "...", "pid": <n> }` to `$CADENCE_HOME/runtime.json`; remove it on graceful stop. Enables the app-smoke + future tooling to find the ephemeral port.
  - Verify: `bun test` — starting a gateway writes `runtime.json` with the bound port; `stop()` removes it; `bun run build` green.

**Stage 1 acceptance:** three overrides/features land with tests; `bun test` count rises; build green. No toolchain used.

## Stage 2 — Self-contained sidecar (auto-verifiable smoke)
- [x] **2.1 Sidecar build script.** `[auto]` `scripts/build-sidecar.ts` (run via `bun`): compute the Rust host
  triple (`rustc --print host-tuple`, fallback parse `rustc -vV | grep host`), map to the `bun build --compile`
  target (`aarch64-apple-darwin→bun-darwin-arm64`, `x86_64-apple-darwin→bun-darwin-x64`, `*linux*→bun-linux-…`),
  compile `server/src/index.ts --compile --minify --sourcemap --outfile src-tauri/binaries/cadence-server-<triple>`,
  then copy `web/dist→src-tauri/resources/web` and `server/drizzle→src-tauri/resources/drizzle`. Root script `sidecar:build`.
  - Verify: after `bun run --filter @cadence/web build` + `bun run sidecar:build`, the triple-named binary + both resource dirs exist (ignored by git).
- [x] **2.2 Sidecar smoke.** `[auto]` `scripts/sidecar-smoke.ts`: run the compiled binary with `CADENCE_PORT=0`,
  `CADENCE_HOME=<tmp>`, `CADENCE_WEB_DIR=<resources/web>`, `CADENCE_MIGRATIONS_DIR=<resources/drizzle>`; read the
  printed URL (or `runtime.json`); assert `GET /api/health` ok, `index.html` served, `<tmp>/cadence.db` created;
  kill the child. Root script `sidecar:smoke`.
  - Verify: `bun run sidecar:smoke` exits 0 on a clean tmp home; re-runnable. Retires the `bun:sqlite`/Drizzle/static-serving packaging risk.

**Stage 2 acceptance:** `sidecar:build` then `sidecar:smoke` pass from a clean checkout — the gateway runs self-contained, no source-relative paths.

## Stage 3 — Tauri scaffold + supervisor
- [ ] **3.1 Scaffold `src-tauri/` + config.** `[auto]` Create the crate (`bun x tauri init` or hand-authored).
  `tauri.conf.json`: identifier `me.cadence.app`, product "Cadence", main window created **hidden**;
  `build.beforeDevCommand="bun run dev"`, `build.devUrl="http://localhost:5173"`,
  `build.beforeBuildCommand` = web build + `sidecar:build`; `bundle.externalBin=["binaries/cadence-server"]`,
  `bundle.resources=["resources/**/*"]`, `bundle.macOS` category + Regular activation (Dock + menubar).
  Add `tauri-plugin-shell` + capability `shell:allow-execute` for `{ name:"binaries/cadence-server", sidecar:true, args:true }`.
  Root scripts `tauri:dev`/`tauri:build`; generate icons (`bun x tauri icon`). Add a `src-tauri/src/lib.rs`
  `#[cfg(test)]` using the `tauri::test` mock runtime as the home for `cargo test`.
  - Verify `[auto]`: `cargo build` (in `src-tauri`) compiles; `cargo test` runs (≥1 mock-runtime test); `bun test` + `bun run build` unaffected.
- [ ] **3.2 Sidecar supervisor (Rust).** `[auto]` `lib.rs` `setup()`: **dev** (`tauri::is_dev()` / `cfg!(debug_assertions)`)
  → point window at `devUrl`, don't spawn. **prod** → `app.shell().sidecar("cadence-server")` with env `CADENCE_PORT=0`,
  `CADENCE_HOME`, `CADENCE_WEB_DIR`/`CADENCE_MIGRATIONS_DIR` from `app.path().resolve("…", BaseDirectory::Resource)`,
  plus resolved PATH + `CADENCE_CLAUDE_BIN` (Stage 4). Read `CommandEvent::Stdout`, regex `http://localhost:\d+`,
  navigate the main window to `WebviewUrl::External(url)` + `show()`; "Starting Cadence…" splash until ready.
  Kill the child on `RunEvent::ExitRequested`/`Exit` (+ the gateway self-stops on SIGTERM as backup).
  Factor the parse + env-build into pure fns under `#[cfg(test)]`.
  - Verify `[auto]`: `cargo test` asserts the stdout→URL parser + env map + dev/prod URL branch; `bun x tauri build` produces a `.app`.
- [ ] **3.3 App smoke.** `[auto]` `scripts/app-smoke.ts`: launch the built `.app` (`open -a` / direct exec), poll
  `~/.cadence/runtime.json`, `curl /api/health`, assert exactly one `cadence-server` child; quit the app; assert
  **no orphan** `cadence-server`. Relaunch while running → still exactly one process (pre-checks single-instance).
  Root script `app:smoke`.
  - Verify: `bun run app:smoke` exits 0 — autonomously proves the supervisor spawns, wires env, serves, and cleans up.

**Stage 3 acceptance:** built `.app` boots to the real UI from the bundled sidecar; `app:smoke` green (spawn + serve + clean shutdown).
**§Visual:** the window visibly renders the Cadence UI (not a blank/again screen).

## Stage 4 — PATH & `claude` resolution
macOS apps launched from Finder don't inherit the shell `PATH`, so the sidecar wouldn't find `claude` (usually `~/.local/bin`) or maybe `git`.
- [ ] **4.1 Resolve login-shell PATH (Rust).** `[auto]` Before spawning, run `$SHELL -lic 'printf %s "$PATH"'`,
  sanitize, set as the sidecar's `PATH`; fall back to `/usr/bin:/bin:/usr/local/bin:$HOME/.local/bin`.
  - Verify `[auto]`: `cargo test` asserts the resolver returns a non-empty PATH containing `/usr/bin` (+ that the
    fallback is used when `$SHELL` is unset). §Visual: from the **Finder-launched** `.app`, spawn a session on a task → `claude` is found and streams.
- [ ] **4.2 "Claude binary path" setting.** `[auto]` Add optional `claudeBinPath` to the settings store + a web
  Settings field; the gateway exports it as `CADENCE_CLAUDE_BIN` (already honored at `spawn.ts`/`runner.ts`/`sessions.ts`).
  - Verify: `bun test` — a set `claudeBinPath` reaches the spawn env; Settings UI renders the field; `bun run build` green.

**Stage 4 acceptance:** PATH resolver tested; explicit binary path overrides PATH. **§Visual:** Finder-launched app spawns `claude`.

## Stage 5 — Native shell (full pass)
- [ ] **5.1 Tray / menubar.** `[visual]` `TrayIconBuilder` + menu: Open Cadence · Quick capture · Today · Inbox · — · Quit. Left-click → show+focus+unminimize main window. Icon in `icons/`.
  - Verify `[auto]`: `cargo build`; `cargo test` asserts the menu builds + has the expected item ids. §Visual: tray icon shows; items act; Quit ends app + sidecar.
- [ ] **5.2 Global hotkey → quick-capture.** `[visual]` `tauri-plugin-global-shortcut`; register `CmdOrCtrl+Shift+Space`;
  handler shows+focuses the window + `emit`s `quick-capture`. Web (feature-detected): `useTauriBridge()` listens for
  `quick-capture` only when `window.__TAURI__` exists → opens the existing `AddTaskModal` (lift its open-state).
  Set `app.withGlobalTauri=true`; add a `remote.urls:["http://localhost:*"]` capability granting event + notification perms.
  - Verify `[auto]`: `cargo test` asserts `global_shortcut().is_registered("CmdOrCtrl+Shift+Space")`; `bun test` asserts
    `useTauriBridge` is inert without `__TAURI__` and opens the modal when a mocked event fires; `bun run build` green.
    §Visual: the hotkey from another app brings Cadence forward with the capture modal focused → task lands in Inbox.
- [ ] **5.3 Native notifications bridge.** `[visual]` In `notifications/store.ts` `fireDesktop()`: under `__TAURI__`,
  use `@tauri-apps/plugin-notification`; else keep Web Notifications. Capability grants `notification:default` to the localhost origin.
  - Verify `[auto]`: `bun test` — the web path is unchanged when `__TAURI__` is absent; the Tauri branch is taken when it's mocked present; `bun run build` green. §Visual: a `needs_feedback`/`delivered` event raises a real macOS banner.
- [ ] **5.4 Single-instance.** `[auto]` `tauri-plugin-single-instance`; on 2nd launch focus the existing window (+ optionally fire `quick-capture`).
  - Verify `[auto]`: `cargo build`; extend `app:smoke` — relaunch while running asserts exactly one `cadence-server` and one window. §Visual: 2nd launch visibly focuses the running window.
- [ ] **5.5 Autostart.** `[auto]` `tauri-plugin-autostart` (LaunchAgent) + a "Launch at login" toggle in web Settings (via the `__TAURI__` bridge).
  - Verify `[auto]`: `cargo build`; `bun run build`; extend `app:smoke` — enabling autostart creates `~/Library/LaunchAgents/<id>.plist`, disabling removes it. §Visual: after enabling + reboot, Cadence launches to the tray.

**Stage 5 acceptance:** tray, hotkey, notifications, single-instance, autostart implemented; all `[auto]` checks green; §Visual items queued.

## Stage 6 — Release, docs, acceptance
- [ ] **6.1 Release build + docs.** `[auto]` `bun x tauri build` → `.app` + `.dmg`. Add `docs/tauri-wrap.md` (prereqs,
  dev workflow, `sidecar:build`/`app:smoke`/`tauri:build`, signing/notarization notes — unsigned is fine for personal local use).
  - Verify `[auto]`: `bun x tauri build` produces a launchable bundle; `bun run app:smoke` green against the release build. §Visual: install the `.dmg` on a clean `~/.cadence` → first run migrates + boots.
- [ ] **6.2 Final acceptance + ledger close.** `[auto]` Confirm every `[auto]` check across all stages is green
  (`bun test`, `cargo test`, `sidecar:smoke`, `app:smoke`, `bun run build`, `tauri build`). Flip 4.7 → `[x]` in
  `docs/build-plan.md` with a journal entry + acceptance block; tick `docs/backlog.md` (4.7 + cross-cutting
  menubar/hotkey); update `CLAUDE.md` Status; set this snapshot to `🎉 TAURI WRAP COMPLETE`. Print the consolidated
  § Visual smoke checklist for the human.
  - Verify: all automated suites green; ledgers updated; loop announces completion + the visual checklist.

---

## § Visual smoke checklist (non-blocking — the human runs this once at the end)
> The loop appends concrete items here as it completes `[visual]` steps. macOS can't automate these (no WKWebView
> WebDriver), so they're confirmed by eye after the build is otherwise complete + machine-verified.
- [ ] (3.x) The window renders the Cadence UI (Today/Inbox visible), not a blank page.
- [ ] (4.x) Spawning a session on a task from the Finder-launched `.app` finds `claude` and streams.
- [ ] (5.1) Tray icon visible in the menubar; menu items work; Quit leaves no process.
- [ ] (5.2) Global hotkey from another app focuses Cadence + opens quick-capture; the task appears in Inbox.
- [ ] (5.3) A `needs_feedback`/`delivered` event shows a native macOS notification banner.
- [ ] (5.4) Launching a 2nd time focuses the running window (no duplicate).
- [ ] (5.5) Enable "Launch at login", reboot → Cadence starts to the tray.

## Risks & mitigations
| Risk | Mitigation | Step |
|---|---|---|
| macOS can't WebDriver-test the webview | `cargo test` mock runtime + process/HTTP/fs smokes; small visual checklist | model |
| GUI app lacks shell PATH → `claude`/`git` not found | resolve login-shell PATH in Rust + `CADENCE_CLAUDE_BIN` setting | 4.1 / 4.2 |
| Compiled binary can't find `web/dist` / migrations | ship as Tauri resources; `CADENCE_WEB_DIR` / `CADENCE_MIGRATIONS_DIR` overrides | 1.1 / 1.2 / 2.1 |
| `bun:sqlite` / native bits in `--compile` | proven by `sidecar:smoke` (DB created from the standalone binary) | 2.2 |
| Long-lived sidecar orphaned on exit | explicit kill on `RunEvent::ExitRequested`/`Exit`; gateway SIGTERM backup; `app:smoke` orphan check | 3.2 / 3.3 |
| WKWebView Web Notifications unreliable | feature-detected bridge to the Tauri notification plugin | 5.3 |
| Window opens before gateway ready / port clash | `CADENCE_PORT=0`; Rust waits for the printed URL; `runtime.json` | 3.2 / 1.3 |
| Code signing / Gatekeeper | fine unsigned for personal local use; document signing/notarization | 6.1 |

## Progress Journal (append-only — newest at bottom)
<!-- Each entry: date · stage.step · what you did · decisions · deviations · notes for next session. -->

- **2026-06-09 · 0.1 (toolchain ensure).** Installed the Rust toolchain via rustup non-interactively
  (`rustc`/`cargo` 1.96.0, host triple `aarch64-apple-darwin`) — lives outside the repo under
  `~/.cargo` + `~/.rustup`, so no repo diff from it. Added `@tauri-apps/cli@2.11.2` as a dev dep
  (`bun add -d`), the only repo change (`package.json` + `bun.lock`). Xcode CLT already present
  (`/Library/Developer/CommandLineTools`). Verified: `rustc`/`cargo`/`bun x tauri --version` all
  report; `bun test` 233 pass / 0 fail; `bun run build` green across shared/server/web.
  *Next:* 0.2 — re-open 4.7 in `build-plan.md` + `backlog.md`, add `src-tauri/{target,binaries,resources,gen}/`
  to `.gitignore`. To use cargo/rustc in later steps, `source "$HOME/.cargo/env"` first (shell state
  doesn't persist between tool calls).

- **2026-06-09 · 0.2 (re-open 4.7 + wire ledgers).** Flipped `build-plan.md` 4.7 from
  `[x] OUT OF SCOPE` → `[~] IN PROGRESS` with a pointer to this ledger + the loop prompt, and updated
  its Status snapshot (the "build complete" parenthetical + Next-step) to reflect the re-opened loop.
  Added a trackable `[~]` Tauri line under `backlog.md` Phase 4 (6.2 will tick it). Added
  `src-tauri/{target,binaries,resources,gen}/` to `.gitignore` with a note that `src-tauri/Cargo.lock`
  stays tracked (verified: `git check-ignore` ignores `target/`, does NOT ignore `Cargo.lock`).
  Verified: `git status` shows only the 3 intended files; `bun test` 233 pass; `bun run build` green.
  Stage 0 complete. *Next:* 1.1 — `CADENCE_WEB_DIR` override in `server/src/gateway.ts` (pure TS,
  fully auto-verifiable; Stage 1 is done first to de-risk before any Rust).

- **2026-06-09 · 1.1 (`CADENCE_WEB_DIR` override).** `server/src/gateway.ts`: `webDir = opts.webDir ??
  process.env.CADENCE_WEB_DIR ?? DEFAULT_WEB_DIR` (explicit opt still wins, so existing tests are
  unaffected). This lets the compiled sidecar serve assets shipped as Tauri bundle resources instead
  of the source-relative `../../web/dist`. Added a self-contained `gateway.test.ts` case that starts a
  gateway with **no** `webDir` opt but `CADENCE_WEB_DIR` pointed at a temp fixture and asserts `/`
  serves the fixture's `index.html`. Verified: gateway suite 40 pass; full `bun test` 234 pass (+1);
  `bun run build` green. *Next:* 1.2 — `CADENCE_MIGRATIONS_DIR` override in `server/src/db/client.ts`.

- **2026-06-09 · 1.2 (`CADENCE_MIGRATIONS_DIR` override).** `server/src/db/client.ts`: `migrateDb`
  now migrates from `process.env.CADENCE_MIGRATIONS_DIR ?? migrationsFolder`, resolved **at call time**
  (not import time) so a test can set the env then call `openAndMigrate`. `migrationsFolder` const
  stays the source-relative default; it's internal to `client.ts` (no external importers), so no
  breakage. Added a `db.test.ts` case proving the env is actually consulted: an empty dir → migrate
  throws (no drizzle journal); the real `server/drizzle` dir → every core table is created (selects
  return `[]` instead of "no such table"). Verified: db suite 3 pass; full `bun test` 235 pass (+1);
  `bun run build` green. *Next:* 1.3 — write `$CADENCE_HOME/runtime.json` on startup, remove on stop.

- **2026-06-09 · 1.3 (runtime port file).** `server/src/gateway.ts`: after binding, write
  `{ port, url, pid }` to `join(cadenceHome(), "runtime.json")` (best-effort, `mkdir -p` first, errors
  swallowed so a write failure never stops serving); the path is captured in a closure so `stop()`
  removes the *same* file (via `rmSync(force:true)`) even if `CADENCE_HOME` later changes. Lets the
  Tauri supervisor + `app:smoke` discover the ephemeral `CADENCE_PORT=0` port without scraping stdout.
  Added a self-contained `gateway.test.ts` case (own temp `CADENCE_HOME`): startup writes
  `runtime.json` with the bound port/url/pid; `stop()` removes it. Verified: gateway suite 41 pass;
  full `bun test` 236 pass (+1); `bun run build` green. **No real-home pollution** — both
  gateway-starting test files set `CADENCE_HOME` to a temp dir, and re-running the suite left the real
  `~/.cadence/runtime.json` mtime unchanged. *Live confirmation:* a real watch-reloaded dev gateway
  (pid alive, port 4477) wrote a valid `runtime.json` to the real home on my edit — end-to-end proof.
  Stage 1 complete (3 relocation overrides land, test count 233→236). *Next:* 2.1 — `scripts/build-sidecar.ts`.
  NOTE for next iter: a live dev gateway may be running on **4477** (watch mode); tests use temp homes
  + port 0, so they're isolated from it.

- **2026-06-09 · 2.1 (sidecar build script).** Added `scripts/build-sidecar.ts` + root script
  `sidecar:build`. It resolves the Rust host triple (`rustc --print host-tuple`, falling back to
  `~/.cargo/bin/rustc` and to parsing `rustc -vV` — robust when rustc isn't on a `bun run` PATH),
  maps it to a Bun compile target (`aarch64-apple-darwin → bun-darwin-arm64`, x64/linux/windows
  handled), then `bun build server/src/index.ts --compile --minify --sourcemap --target=<t> --outfile
  src-tauri/binaries/cadence-server-<triple>` and stages `web/dist → resources/web` +
  `server/drizzle → resources/drizzle` (rm+cp, fails loudly if `web/dist` is missing). The triple
  suffix matches Tauri's `externalBin` sidecar resolution. Verified: `bun run --filter @cadence/web
  build` then `bun run sidecar:build` → `cadence-server-aarch64-apple-darwin` is a **Mach-O 64-bit
  arm64 executable**, `resources/web/index.html` + all 5 drizzle migrations present; `git status`
  shows only `package.json` + `scripts/` (artifacts git-ignored, confirmed via `git check-ignore`);
  `bun test` 236 pass; `bun run build` green. *Next:* 2.2 — `scripts/sidecar-smoke.ts` runs the
  compiled binary on a clean tmp home (port 0) and curls `/api/health`, retiring the
  `bun:sqlite`/static-serving packaging risk.

- **2026-06-09 · 2.2 (sidecar smoke).** Added `scripts/sidecar-smoke.ts` + root script
  `sidecar:smoke`. It finds the `cadence-server-<triple>` binary (skipping the `index.js.map`
  sourcemap), launches it with `CADENCE_PORT=0` + a fresh tmp `CADENCE_HOME` and
  `CADENCE_WEB_DIR`/`CADENCE_MIGRATIONS_DIR` pointed at the staged resources, waits for the gateway to
  write `runtime.json` (the port-discovery path from 1.3), then asserts `GET /api/health` ok +
  `index.html` served + `cadence.db` created, kills the child, removes the tmp home. **Verified:**
  ran `bun run sidecar:smoke` twice → both exit 0 on ephemeral ports (53500, 53503), health ok,
  index served, DB created. This is the big de-risk: the standalone `--compile` binary boots,
  opens **bun:sqlite**, applies the bundled **drizzle** migrations, and serves the bundled web —
  **with no Bun installed in its env**. `bun test` 236 pass; `bun run build` green. Stage 2 complete.
  *Next:* 3.1 — scaffold `src-tauri/` (Cargo crate + `tauri.conf.json` + `lib.rs` with a
  `tauri::test` mock-runtime test); first Rust step, so `cargo build`/`cargo test` gates begin.
