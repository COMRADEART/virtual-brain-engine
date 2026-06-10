// Sidecar supervision — the "one app" seam. In a bundled (release) build the
// Tauri shell owns the Node brain server: it spawns the bundled runtime
// (binaries/brain-server-<triple>) on the bundled payload
// (resources/server/server.mjs), points BRAIN_DATA_DIR at the OS app-data dir,
// supervises it (bounded restarts on crash), and kills it on app exit.
//
// Rules:
//   * DEV builds never spawn — `npm run dev:all` / `dev:server` owns :8787.
//   * If :8787 already answers (an external/dev server), we adopt it instead
//     of double-binding — the sidecar is a convenience, not a monopoly.
//   * The Python perception worker is NOT spawned here: its ML deps are
//     multi-GB and every consumer degrades gracefully when it's down. It
//     stays an optional, separately-started process (worker/README.md).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 8787;
const MAX_RESTARTS: u32 = 5;

/// Shared handle so the exit path can kill the live child.
#[derive(Default)]
pub struct SidecarState {
    child: parking_lot::Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
}

impl SidecarState {
    pub fn kill(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().take() {
            let _ = child.kill();
            log::info!("[sidecar] brain-server killed on exit");
        }
    }
}

/// Strip Windows' verbatim prefix (`\\?\C:\...`). Tauri's `resource_dir()`
/// returns verbatim paths on Windows and Node's CJS module resolver cannot
/// load a main script through one (it lstat's `C:` and dies with EISDIR).
fn de_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

fn port_in_use() -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], PORT)),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

/// Spawn + supervise the Node server sidecar. No-op in dev builds, when the
/// bundle payload is missing, or when something already serves :8787.
pub fn start_server_sidecar(app: &AppHandle) {
    if cfg!(debug_assertions) {
        log::info!("[sidecar] dev build — expecting `npm run dev:server` to own :{PORT}");
        return;
    }
    let Ok(resource_dir) = app.path().resource_dir() else {
        log::warn!("[sidecar] no resource dir — skipping brain-server spawn");
        return;
    };
    let server_mjs = resource_dir.join("resources").join("server").join("server.mjs");
    if !server_mjs.exists() {
        log::warn!("[sidecar] bundle payload missing at {server_mjs:?} — skipping spawn");
        return;
    }
    if port_in_use() {
        log::info!("[sidecar] :{PORT} already serving — adopting the existing brain server");
        return;
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("brain-server"))
        .unwrap_or_else(|_| std::env::temp_dir().join("brain-server"));
    let _ = std::fs::create_dir_all(&data_dir);

    let state: Arc<SidecarState> = Arc::new(SidecarState::default());
    app.manage(state.clone());

    let restarts = Arc::new(AtomicU32::new(0));
    spawn_once(app.clone(), server_mjs, data_dir, state, restarts);
}

fn spawn_once(
    app: AppHandle,
    server_mjs: std::path::PathBuf,
    data_dir: std::path::PathBuf,
    state: Arc<SidecarState>,
    restarts: Arc<AtomicU32>,
) {
    let command = match app.shell().sidecar("brain-server") {
        Ok(c) => c
            .args([de_verbatim(&server_mjs)])
            .env("BRAIN_DATA_DIR", de_verbatim(&data_dir))
            .env("PORT", PORT.to_string())
            .env("HOST", "127.0.0.1"),
        Err(e) => {
            log::error!("[sidecar] could not resolve brain-server binary: {e}");
            return;
        }
    };

    let (mut rx, child) = match command.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            log::error!("[sidecar] brain-server spawn failed: {e}");
            return;
        }
    };
    log::info!("[sidecar] brain-server up on :{PORT} (data: {data_dir:?})");
    *state.child.lock() = Some(child);

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[brain-server] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[brain-server] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    *state.child.lock() = None;
                    if state.shutting_down.load(Ordering::SeqCst) {
                        return; // intentional kill on app exit
                    }
                    let n = restarts.fetch_add(1, Ordering::SeqCst) + 1;
                    if n > MAX_RESTARTS {
                        log::error!(
                            "[sidecar] brain-server crashed (code {:?}) and exceeded {MAX_RESTARTS} restarts — giving up",
                            payload.code
                        );
                        return;
                    }
                    log::warn!(
                        "[sidecar] brain-server exited (code {:?}) — restart {n}/{MAX_RESTARTS} in 2s",
                        payload.code
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    spawn_once(app.clone(), server_mjs.clone(), data_dir.clone(), state.clone(), restarts.clone());
                    return; // the new spawn owns its own event loop
                }
                _ => {}
            }
        }
    });
}
