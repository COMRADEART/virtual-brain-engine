// Phase 2b — OS ambient collectors. Read-only OS sources the headless Node
// server can't reach itself; the frontend pushes what these return to
// /api/ingest/push, where consent + redaction + dedup + audit governance is
// enforced. The frontend ALSO gates reading on the source's consent, so the
// clipboard isn't even read until the user opts in.
//
// Only clipboard is implemented here; recent-docs and app-usage are further
// collectors that feed the SAME push seam.

use arboard::Clipboard;

/// Returns the current clipboard text, or None when it's empty / non-text.
/// A clipboard with no text is normal, not an error.
#[tauri::command]
pub fn collect_clipboard() -> Result<Option<String>, String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    match clipboard.get_text() {
        Ok(text) if !text.trim().is_empty() => Ok(Some(text)),
        Ok(_) => Ok(None),
        Err(_) => Ok(None),
    }
}
