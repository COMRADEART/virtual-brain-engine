use desktop_bridge::{ChatInput, CommandInput, DesktopBridge, GraphOutput, IngestMemoryInput, ProjectInput};
use shared_types::BrainConfig;
use tauri::Manager;

#[derive(Clone)]
struct BridgeState {
    bridge: DesktopBridge,
}

#[tauri::command]
async fn brain_dashboard(state: tauri::State<'_, BridgeState>) -> Result<brain_core::BrainDashboard, String> {
    state.bridge.dashboard().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn brain_chat(input: ChatInput, state: tauri::State<'_, BridgeState>) -> Result<desktop_bridge::ChatOutput, String> {
    state.bridge.chat(input).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ingest_memory(input: IngestMemoryInput, state: tauri::State<'_, BridgeState>) -> Result<shared_types::MemoryRecord, String> {
    state.bridge.ingest_memory(input).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn observe_project(input: ProjectInput, state: tauri::State<'_, BridgeState>) -> Result<shared_types::ProjectRecord, String> {
    state.bridge.observe_project(input).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_safe_command(input: CommandInput, state: tauri::State<'_, BridgeState>) -> Result<(), String> {
    state.bridge.run_command(input).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn knowledge_graph(state: tauri::State<'_, BridgeState>) -> Result<GraphOutput, String> {
    state.bridge.graph().await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&app_dir).ok();
            let config = BrainConfig {
                data_dir: app_dir.to_string_lossy().into_owned(),
                sqlite_path: app_dir.join("computer-brain.sqlite").to_string_lossy().into_owned(),
                ..BrainConfig::default()
            };
            let handle = tauri::async_runtime::block_on(DesktopBridge::boot(config))
                .expect("failed to boot Computer Brain");
            app.manage(BridgeState { bridge: handle });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            brain_dashboard,
            brain_chat,
            ingest_memory,
            observe_project,
            run_safe_command,
            knowledge_graph,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Computer Brain");
}
