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

use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the supervised gateway child so the app can terminate it on exit (no orphaned cadence-server).
struct SidecarChild(Mutex<Option<CommandChild>>);

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
/// from stdout. PATH resolution + CADENCE_CLAUDE_BIN are layered in by Stage 4.
fn sidecar_env(home: &str, web_dir: &str, migrations_dir: &str) -> HashMap<String, String> {
    HashMap::from([
        ("CADENCE_PORT".to_string(), "0".to_string()),
        ("CADENCE_HOME".to_string(), home.to_string()),
        ("CADENCE_WEB_DIR".to_string(), web_dir.to_string()),
        ("CADENCE_MIGRATIONS_DIR".to_string(), migrations_dir.to_string()),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
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

                let env = sidecar_env(
                    &home.to_string_lossy(),
                    &web_dir.to_string_lossy(),
                    &migrations_dir.to_string_lossy(),
                );

                let (mut rx, child) = app.shell().sidecar("cadence-server")?.envs(env).spawn()?;
                app.manage(SidecarChild(Mutex::new(Some(child))));

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

    // Ensure the supervised gateway never outlives the app (no orphaned cadence-server). The gateway
    // also self-stops on SIGTERM as a backup.
    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<SidecarChild>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_gateway_url, sidecar_env, start_url};

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
        let env = sidecar_env("/Users/x/.cadence", "/app/resources/web", "/app/resources/drizzle");
        assert_eq!(env.get("CADENCE_PORT").map(String::as_str), Some("0"));
        assert_eq!(env.get("CADENCE_HOME").map(String::as_str), Some("/Users/x/.cadence"));
        assert_eq!(env.get("CADENCE_WEB_DIR").map(String::as_str), Some("/app/resources/web"));
        assert_eq!(
            env.get("CADENCE_MIGRATIONS_DIR").map(String::as_str),
            Some("/app/resources/drizzle")
        );
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
}
