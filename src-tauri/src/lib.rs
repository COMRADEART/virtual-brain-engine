mod commands;
mod database;
mod file_watcher;
mod llm_probe;
mod system_monitor;

use commands::{
    add_memory_point, get_app_state, get_git_activity, get_project_context,
    get_project_stats, get_recent_activity, get_recent_memories, get_system_metrics,
    record_brain_activity, save_project_context, start_monitoring, stop_monitoring,
    toggle_brain_activity, toggle_system_metrics, unwatch_project, watch_project, AppState,
};
use llm_probe::probe_local_llms;
use database::create_database;
use file_watcher::create_file_watcher;
use parking_lot::RwLock;
use system_monitor::create_system_monitor;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            std::fs::create_dir_all(&app_data_dir).ok();

            let db = create_database(&app_data_dir)
                .expect("Failed to create database");
            app.manage(db);

            let file_watcher = create_file_watcher();
            app.manage(file_watcher);

            let system_monitor = create_system_monitor();
            app.manage(system_monitor);

            let app_state = Arc::new(RwLock::new(AppState::default()));
            app.manage(app_state);

            log::info!("Virtual Brain Engine started");
            log::info!("App data directory: {:?}", app_data_dir);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_system_metrics,
            start_monitoring,
            stop_monitoring,
            watch_project,
            unwatch_project,
            get_project_stats,
            get_git_activity,
            record_brain_activity,
            get_recent_activity,
            add_memory_point,
            get_recent_memories,
            save_project_context,
            get_project_context,
            get_app_state,
            toggle_system_metrics,
            toggle_brain_activity,
            probe_local_llms,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}