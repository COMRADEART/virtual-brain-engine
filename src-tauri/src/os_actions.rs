// OS-surface action executor (Phase 3b). The Node server validates, confirm-
// gates, and audits a command, then returns an osDirective; this is where the
// actual OS operation runs — in the Tauri renderer.
//
// Uses tauri-plugin-opener (the OS default handler), NOT a shell interpreter, so
// a crafted target cannot inject a command. Combined with the server-side
// allowlist + zod validation + confirm token, this is the full guard:
// server authorises → Tauri opens.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn os_open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn os_open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
