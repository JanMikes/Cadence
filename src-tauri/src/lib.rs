//! Cadence native shell (Tauri). A thin Rust supervisor that boots the self-contained Bun gateway as
//! a sidecar and hosts the existing web UI in a webview pointed at the gateway's own localhost origin.
//! The sidecar supervisor + native shell (tray, hotkey, notifications) are layered on in later steps;
//! 3.1 only scaffolds the crate, registers the shell plugin, and establishes the mock-runtime test home.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// Build the app on Tauri's headless MockRuntime. macOS has no WKWebView WebDriver, so this is the
    /// home for unit-testing the supervisor's pure logic (URL parse, env map) added in 3.2 — proving
    /// the builder + plugins initialize without a real window.
    #[test]
    fn builds_on_the_mock_runtime() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("the mock app should build");
        // A usable handle proves setup/plugins initialized under the mock runtime.
        let _ = app.handle();
    }
}
