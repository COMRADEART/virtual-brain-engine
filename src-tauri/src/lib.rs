mod collectors;
mod commands;
mod database;
mod file_watcher;
mod llm_probe;
mod os_actions;
mod phase2;
mod screen_capture;
mod sidecars;
mod system_monitor;

use commands::{
    add_memory_point, get_app_state, get_autostart, get_git_activity, get_project_context,
    get_project_stats, get_recent_activity, get_recent_memories, get_system_metrics,
    notify, pet_set_size, pet_start_drag, record_brain_activity, save_project_context,
    set_autostart, show_main_window, start_monitoring, stop_monitoring, toggle_brain_activity,
    toggle_system_metrics, unwatch_project, watch_project, AppState,
};
use collectors::collect_clipboard;
use llm_probe::probe_local_llms;
use os_actions::{os_open_path, os_open_url};
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
    Emitter, Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--person-on-startup"]),
        ))
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

            // One-app mode: in a bundled build, spawn + supervise the Node
            // brain server (binaries/brain-server + resources/server). No-op
            // in dev or when :8787 is already served.
            sidecars::start_server_sidecar(app.handle());

            // Tray menu: quick-access surface for the "person on the computer"
            // promise. Left-click still focuses the main window (intentional —
            // it's the muscle-memory path). Menu items route through Tauri
            // commands so the renderer is the source of truth for state.
            let show_item = MenuItem::with_id(app, "show", "Open Brain OS", true, None::<&str>)?;
            let pet_item = MenuItem::with_id(app, "pet", "Show Pet", true, None::<&str>)?;
            let voice_item = MenuItem::with_id(app, "voice", "Voice on/off", true, None::<&str>)?;
            let listen_item = MenuItem::with_id(app, "listen", "Listen for 'Brain'", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &pet_item, &voice_item, &listen_item, &separator, &quit_item],
            )?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Brain OS — Running")
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    // The renderer owns state for voice/listen toggles; we
                    // emit a bus event the renderer listens for, so the
                    // tray menu and the renderer stay in lock-step.
                    match id {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "pet" => {
                            if let Some(window) = app.get_webview_window("pet") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            let _ = app.emit("tray-pet", ());
                        }
                        "voice" => {
                            let _ = app.emit("tray-voice-toggle", ());
                        }
                        "listen" => {
                            let _ = app.emit("tray-listen-toggle", ());
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
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

            // Global hotkey: Cmd/Ctrl+Shift+B summons the person from any
            // focused app. The persona's promise: "I'm always one keystroke
            // away." If main is hidden, show it; if main is shown but pet
            // is hidden, show the pet; if both are visible, flash a tiny
            // notification. Default accelerator is registered here; the
            // user can change it later via the Settings panel
            // (register_global_hotkey command) — for now we ship the one
            // binding.
            //
            // ponytail: dynamic registration is preferred over the static
            // `tauri.conf.json` array so the user can change the binding
            // at runtime without a rebuild.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyB);
                let app_handle = app.handle().clone();
                if let Err(e) = app.global_shortcut().on_shortcut(shortcut, move |_app, _scut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let main_visible = app_handle
                            .get_webview_window("main")
                            .map(|w| w.is_visible().unwrap_or(false))
                            .unwrap_or(false);
                        let pet_visible = app_handle
                            .get_webview_window("pet")
                            .map(|w| w.is_visible().unwrap_or(false))
                            .unwrap_or(false);

                        if !main_visible {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        } else if !pet_visible {
                            if let Some(window) = app_handle.get_webview_window("pet") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        } else {
                            // Both visible — flash a quiet confirmation
                            // and bring the pet to focus (it's the
                            // conversational surface).
                            let _ = app_handle.emit("person-summoned", ());
                            if let Some(window) = app_handle.get_webview_window("pet") {
                                let _ = window.set_focus();
                            }
                        }
                    }
                }) {
                    log::warn!("failed to register global shortcut: {}", e);
                }
            }

            // Autostart on login: the personal-brain promise. ON by default;
            // users can opt out from Settings. The check below is
            // best-effort: if the user previously disabled it, leave it
            // disabled.
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                match manager.is_enabled() {
                    Ok(true) => log::info!("autostart-on-login: already enabled"),
                    Ok(false) => {
                        if let Err(e) = manager.enable() {
                            log::warn!("failed to enable autostart-on-login: {}", e);
                        } else {
                            log::info!("autostart-on-login: enabled (default-on for the personal-brain promise)");
                        }
                    }
                    Err(e) => log::warn!("autostart state check failed: {}", e),
                }
            }

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
            pet_start_drag,
            pet_set_size,
            os_open_path,
            os_open_url,
            collect_clipboard,
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
            // "Person on the computer" presence layer (Slice 1)
            notify,
            set_autostart,
            get_autostart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill the supervised brain-server on app exit — without this the
            // Node process outlives the shell.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<std::sync::Arc<sidecars::SidecarState>>() {
                    state.kill();
                }
            }
        });
}
