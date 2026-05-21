mod commands;
mod database;
mod file_watcher;
mod llm_probe;
mod phase2;
mod screen_capture;
mod system_monitor;

use commands::{
    add_memory_point, get_app_state, get_git_activity, get_project_context,
    get_project_stats, get_recent_activity, get_recent_memories, get_system_metrics,
    record_brain_activity, save_project_context, show_main_window, start_monitoring,
    stop_monitoring, toggle_brain_activity, toggle_system_metrics, unwatch_project,
    watch_project, AppState,
};
use llm_probe::probe_local_llms;
use screen_capture::{
    capture_region, capture_screen, delete_screen_capture, get_monitors,
    get_screen_capture_path, get_vision_config, list_screen_captures, save_vision_config,
};
use database::create_database;
use file_watcher::create_file_watcher;
use phase2::{
    autonomous_due_tasks, autonomous_schedule_task, context_engine_snapshot,
    create_phase2_system, knowledge_graph_snapshot, pet_personality_state,
    phase2_status, project_timeline_recent, record_project_timeline_event, semantic_memory_ingest,
    semantic_memory_search, update_pet_activity, workflow_complete, workflow_enqueue,
    workflow_next_task, workflow_snapshot,
};
use parking_lot::RwLock;
use system_monitor::create_system_monitor;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

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

            let phase2 = create_phase2_system(&app_data_dir)
                .expect("Failed to create Phase 2 cognitive system");
            app.manage(phase2);

            let file_watcher = create_file_watcher();
            app.manage(file_watcher);

            let system_monitor = create_system_monitor();
            app.manage(system_monitor);

            let app_state = Arc::new(RwLock::new(AppState::default()));
            app.manage(app_state);

            log::info!("Virtual Brain Engine started");
            log::info!("App data directory: {:?}", app_data_dir);

            let show_item = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Brain OS — Running")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
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
            show_main_window,
            probe_local_llms,
            phase2_status,
            semantic_memory_ingest,
            semantic_memory_search,
            knowledge_graph_snapshot,
            context_engine_snapshot,
            record_project_timeline_event,
            project_timeline_recent,
            workflow_enqueue,
            workflow_next_task,
            workflow_complete,
            workflow_snapshot,
            pet_personality_state,
            update_pet_activity,
            autonomous_schedule_task,
            autonomous_due_tasks,
            capture_screen,
            capture_region,
            get_monitors,
            get_screen_capture_path,
            list_screen_captures,
            delete_screen_capture,
            get_vision_config,
            save_vision_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
