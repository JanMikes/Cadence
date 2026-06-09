//! Cadence native shell (Tauri). A thin Rust supervisor that boots the self-contained Bun gateway as
//! a sidecar and hosts the existing web UI in a webview pointed at the gateway's own localhost origin.
//!
//! Flow: prod → spawn `cadence-server` (CADENCE_PORT=0 → ephemeral) with the relocation env, read its
//! stdout for the bound `http://localhost:<port>`, navigate the (initially hidden) main window there
//! and show it; kill the child on app exit so nothing is orphaned. dev → `tauri dev` already serves
//! Vite (via the `bun run dev` beforeDevCommand), so we just reveal the window and never spawn.
//!
//! macOS has no WKWebView WebDriver, so the supervisor's decision logic is factored into the pure fns
//! below (`parse_gateway_url`, `sidecar_env`, `start_url`) and unit-tested; the window/process wiring
//! is covered by the process-level `scripts/app-smoke.ts` (step 3.3).

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::ShortcutState;

/// The supervised gateway child, in a process-global so both the in-app quit path (`RunEvent::Exit`)
/// and the POSIX signal handler can terminate it — never orphan a cadence-server.
static SIDECAR: Mutex<Option<CommandChild>> = Mutex::new(None);

/// Kill the supervised gateway sidecar if it's still running (idempotent).
fn kill_sidecar() {
    if let Ok(mut guard) = SIDECAR.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

/// Extract the gateway origin (`http://localhost:<port>`) from a sidecar stdout line.
fn parse_gateway_url(line: &str) -> Option<String> {
    const PREFIX: &str = "http://localhost:";
    let start = line.find(PREFIX)?;
    let digits: String = line[start + PREFIX.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        Some(format!("{PREFIX}{digits}"))
    }
}

/// Environment for the sidecar gateway. CADENCE_PORT=0 → ephemeral; Rust reads the bound port back
/// from stdout. `path` is the recovered login-shell PATH so the gateway can find `claude`/`git` when
/// launched from Finder. `.envs()` merges these over the inherited env, so HOME/USER are preserved.
fn sidecar_env(home: &str, web_dir: &str, migrations_dir: &str, path: &str) -> HashMap<String, String> {
    HashMap::from([
        ("CADENCE_PORT".to_string(), "0".to_string()),
        ("CADENCE_HOME".to_string(), home.to_string()),
        ("CADENCE_WEB_DIR".to_string(), web_dir.to_string()),
        ("CADENCE_MIGRATIONS_DIR".to_string(), migrations_dir.to_string()),
        ("PATH".to_string(), path.to_string()),
    ])
}

/// Which URL the main window loads: dev → the Vite dev server (the sidecar isn't spawned — the
/// `bun run dev` beforeDevCommand already serves it); prod → the spawned gateway's own origin.
fn start_url(is_dev: bool, dev_url: &str, gateway_url: &str) -> String {
    if is_dev {
        dev_url.to_string()
    } else {
        gateway_url.to_string()
    }
}

/// A marker we print right before `$PATH` so login/interactive rc files that emit banners on stdout
/// can't corrupt the captured value.
const PATH_MARKER: &str = "__CADENCE_PATH__";

/// Sane PATH used when the login shell can't be queried (GUI app with no `$SHELL`, capture failed…).
fn fallback_path(home: &str) -> String {
    format!("/usr/bin:/bin:/usr/local/bin:{home}/.local/bin")
}

/// Pull the real PATH out of captured shell stdout (everything after the last marker). `None` if the
/// marker is absent (the printf didn't run) or the value is blank.
fn extract_marked_path(raw: &str) -> Option<String> {
    let (_, after) = raw.rsplit_once(PATH_MARKER)?;
    let trimmed = after.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Resolve a PATH from an optional login `shell`, capturing it via `run_shell`. Falls back to
/// `fallback_path(home)` when there's no shell or the capture is unusable. Split out so the decision
/// is unit-testable without actually spawning a shell.
fn resolve_path_with(
    shell: Option<&str>,
    home: &str,
    run_shell: impl Fn(&str) -> Option<String>,
) -> String {
    let captured = shell.and_then(run_shell);
    captured
        .as_deref()
        .and_then(extract_marked_path)
        .unwrap_or_else(|| fallback_path(home))
}

/// macOS GUI apps launched from Finder don't inherit the shell `PATH`, so the sidecar wouldn't find
/// `claude` (usually `~/.local/bin`) or maybe `git`. Recover it from the user's login shell.
fn resolve_login_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let shell = std::env::var("SHELL").ok();
    resolve_path_with(shell.as_deref(), &home, |s| {
        std::process::Command::new(s)
            .args(["-lic", "printf '__CADENCE_PATH__%s' \"$PATH\""])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    })
}

/// Tray menu item ids — shared by the builder and the click handler so they can't drift.
const TRAY_ITEMS: [(&str, &str); 5] = [
    ("open", "Open Cadence"),
    ("quick_capture", "Quick capture"),
    ("today", "Today"),
    ("inbox", "Inbox"),
    ("quit", "Quit Cadence"),
];

/// Build the tray menu (Open · Quick capture · Today · Inbox · — · Quit) with a separator before Quit.
/// Factored out so a mock-runtime test can assert the items without constructing a real tray icon.
fn build_tray_menu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Menu<R>> {
    let mut items = Vec::new();
    for (id, label) in TRAY_ITEMS {
        items.push(MenuItemBuilder::with_id(id, label).build(app)?);
    }
    let (quit, rest) = items.split_last().expect("TRAY_ITEMS is non-empty");
    let mut builder = MenuBuilder::new(app);
    for item in rest {
        builder = builder.item(item);
    }
    builder.separator().item(quit).build()
}

/// Show, unminimize, and focus the main window (tray click / "Open Cadence").
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Build the menubar/tray icon and wire menu + left-click behaviour. Non-fatal: a failure here logs
/// and leaves the rest of the app working.
fn setup_tray(app: &AppHandle<impl Runtime>) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "today" | "inbox" => {
                show_main(app);
                let _ = app.emit("tray-navigate", event.id().as_ref().to_string());
            }
            "quick_capture" => {
                show_main(app);
                let _ = app.emit("quick-capture", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Global hotkey that brings Cadence forward and opens quick-capture from anywhere.
const QUICK_CAPTURE_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance MUST be the first plugin so a 2nd launch is short-circuited before any other
    // init (e.g. spawning a duplicate sidecar) — it just focuses the already-running window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }));
    }

    builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    // Global shortcut (desktop only): CmdOrCtrl+Shift+Space → show the window + emit quick-capture.
    #[cfg(desktop)]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(QUICK_CAPTURE_SHORTCUT)
                .expect("quick-capture shortcut should parse")
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit("quick-capture", ());
                    }
                })
                .build(),
        );
    }

    let app = builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Menubar/tray icon (Open · Quick capture · Today · Inbox · — · Quit). Non-fatal so a tray
            // failure never blocks the app from starting.
            if let Err(e) = setup_tray(app.handle()) {
                log::warn!("tray setup failed: {e}");
            }

            // The main window is created hidden (visible:false in tauri.conf.json) so the user never
            // sees a blank webview before the gateway is ready. The window always loads
            // `start_url(is_dev, dev_url, gateway_url)`.
            let is_dev = cfg!(debug_assertions);
            let dev_url = app
                .config()
                .build
                .dev_url
                .as_ref()
                .map(|u| u.to_string())
                .unwrap_or_default();
            let window = app.get_webview_window("main");

            if is_dev {
                // Dev: `tauri dev` serves Vite (via the `bun run dev` beforeDevCommand). Load it + show.
                if let Some(window) = &window {
                    if let Ok(parsed) = start_url(true, &dev_url, "").parse::<tauri::Url>() {
                        let _ = window.navigate(parsed);
                    }
                    let _ = window.show();
                }
            } else if window.is_some() {
                // Prod: boot the self-contained gateway sidecar, then navigate to its origin once it
                // reports the bound (ephemeral) port on stdout.
                let home = app
                    .path()
                    .home_dir()
                    .map(|h| h.join(".cadence"))
                    .unwrap_or_else(|_| std::path::PathBuf::from(".cadence"));
                let web_dir = app.path().resolve("resources/web", BaseDirectory::Resource)?;
                let migrations_dir = app.path().resolve("resources/drizzle", BaseDirectory::Resource)?;

                let path = resolve_login_path();
                let env = sidecar_env(
                    &home.to_string_lossy(),
                    &web_dir.to_string_lossy(),
                    &migrations_dir.to_string_lossy(),
                    &path,
                );

                let (mut rx, child) = app.shell().sidecar("cadence-server")?.envs(env).spawn()?;
                *SIDECAR.lock().expect("sidecar lock") = Some(child);

                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut navigated = false;
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => {
                                let line = String::from_utf8_lossy(&bytes);
                                log::info!("[cadence-server] {}", line.trim_end());
                                if !navigated {
                                    if let (Some(url), Some(win)) =
                                        (parse_gateway_url(&line), handle.get_webview_window("main"))
                                    {
                                        let target = start_url(false, &dev_url, &url);
                                        if let Ok(parsed) = target.parse::<tauri::Url>() {
                                            let _ = win.navigate(parsed);
                                            let _ = win.show();
                                            navigated = true;
                                        }
                                    }
                                }
                            }
                            CommandEvent::Stderr(bytes) => {
                                log::warn!(
                                    "[cadence-server] {}",
                                    String::from_utf8_lossy(&bytes).trim_end()
                                );
                            }
                            CommandEvent::Terminated(payload) => {
                                log::error!("[cadence-server] terminated: {payload:?}");
                            }
                            _ => {}
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Cadence application");

    // POSIX termination (SIGTERM/SIGINT from a supervisor, `kill`, or Ctrl-C) bypasses Tauri's
    // RunEvent, so handle it explicitly: kill the sidecar, then exit. signal-hook delivers on a
    // dedicated thread, so kill()+exit() here run in normal context (not an async-signal handler).
    #[cfg(unix)]
    std::thread::spawn(|| {
        if let Ok(mut signals) = signal_hook::iterator::Signals::new([
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGINT,
        ]) {
            if signals.forever().next().is_some() {
                kill_sidecar();
                std::process::exit(0);
            }
        }
    });

    // The in-app quit path (Cmd-Q / window close → terminate) also cleans up the sidecar.
    app.run(|_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            kill_sidecar();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        extract_marked_path, fallback_path, parse_gateway_url, resolve_login_path, resolve_path_with,
        sidecar_env, start_url, TRAY_ITEMS,
    };

    #[test]
    fn parses_gateway_url_from_stdout() {
        assert_eq!(
            parse_gateway_url("[cadence] gateway listening on http://localhost:53500"),
            Some("http://localhost:53500".to_string())
        );
        // trailing path/segments after the port are ignored
        assert_eq!(
            parse_gateway_url("serving http://localhost:8080/board now"),
            Some("http://localhost:8080".to_string())
        );
        assert_eq!(parse_gateway_url("no url on this line"), None);
        assert_eq!(parse_gateway_url("http://localhost: (no port)"), None);
    }

    #[test]
    fn sidecar_env_has_relocation_overrides() {
        let env = sidecar_env(
            "/Users/x/.cadence",
            "/app/resources/web",
            "/app/resources/drizzle",
            "/usr/bin:/Users/x/.local/bin",
        );
        assert_eq!(env.get("CADENCE_PORT").map(String::as_str), Some("0"));
        assert_eq!(env.get("CADENCE_HOME").map(String::as_str), Some("/Users/x/.cadence"));
        assert_eq!(env.get("CADENCE_WEB_DIR").map(String::as_str), Some("/app/resources/web"));
        assert_eq!(
            env.get("CADENCE_MIGRATIONS_DIR").map(String::as_str),
            Some("/app/resources/drizzle")
        );
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin:/Users/x/.local/bin"));
    }

    #[test]
    fn fallback_path_includes_system_and_local_bin() {
        let p = fallback_path("/Users/x");
        assert!(p.contains("/usr/bin"));
        assert!(p.contains("/Users/x/.local/bin"));
    }

    #[test]
    fn extracts_marked_path_past_rc_banners() {
        assert_eq!(
            extract_marked_path("__CADENCE_PATH__/usr/bin:/bin").as_deref(),
            Some("/usr/bin:/bin")
        );
        // an rc file may print a banner on stdout before our marker
        assert_eq!(
            extract_marked_path("welcome to zsh\n__CADENCE_PATH__/opt/homebrew/bin:/usr/bin").as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(extract_marked_path("no marker present"), None);
        assert_eq!(extract_marked_path("__CADENCE_PATH__   "), None);
    }

    #[test]
    fn resolve_path_uses_shell_then_falls_back() {
        // a clean shell capture is used as-is
        assert_eq!(
            resolve_path_with(Some("/bin/zsh"), "/home/x", |_| Some(
                "__CADENCE_PATH__/usr/bin:/bin".into()
            )),
            "/usr/bin:/bin"
        );
        // no $SHELL → fallback
        assert_eq!(resolve_path_with(None, "/home/x", |_| None), fallback_path("/home/x"));
        // shell ran but produced nothing usable → fallback
        assert_eq!(
            resolve_path_with(Some("/bin/zsh"), "/home/x", |_| Some("garbage, no marker".into())),
            fallback_path("/home/x")
        );
    }

    #[test]
    fn resolve_login_path_is_nonempty_with_usr_bin() {
        // Queries the real login shell when $SHELL is set; otherwise the fallback — both contain
        // /usr/bin, so this holds regardless of the host shell config.
        let p = resolve_login_path();
        assert!(!p.is_empty());
        assert!(p.contains("/usr/bin"), "expected /usr/bin in resolved PATH, got: {p}");
    }

    #[test]
    fn dev_loads_vite_prod_loads_gateway() {
        assert_eq!(
            start_url(true, "http://localhost:5173", "http://localhost:4477"),
            "http://localhost:5173"
        );
        assert_eq!(
            start_url(false, "http://localhost:5173", "http://localhost:4477"),
            "http://localhost:4477"
        );
    }

    #[test]
    fn builds_on_the_mock_runtime() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app should build");
        let _ = app.handle();
    }

    #[test]
    fn tray_items_are_the_expected_set() {
        // build_tray_menu() feeds these ids straight into the menu; the actual muda::Menu can only be
        // constructed on the macOS main thread (which the test harness can't guarantee), so the menu
        // *structure* is the deterministic check and the live tray is a §Visual confirmation.
        let ids: Vec<&str> = TRAY_ITEMS.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, ["open", "quick_capture", "today", "inbox", "quit"]);
    }

    #[cfg(desktop)]
    #[test]
    fn quick_capture_shortcut_is_registered() {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let app = tauri::test::mock_builder()
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcut(super::QUICK_CAPTURE_SHORTCUT)
                    .expect("quick-capture shortcut should parse")
                    .build(),
            )
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app should build");
        assert!(app
            .global_shortcut()
            .is_registered(super::QUICK_CAPTURE_SHORTCUT));
    }
}
