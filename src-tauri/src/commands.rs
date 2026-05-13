use crate::database::{BrainActivity, MemoryPoint, ProjectContext};
use crate::file_watcher::{FileChange, GitActivity, ProjectStats};
use crate::system_monitor::SystemMetrics;
use crate::database::SharedDatabase;
use crate::file_watcher::SharedFileWatcher;
use crate::system_monitor::SharedSystemMonitor;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub is_monitoring: bool,
    pub watched_projects: Vec<String>,
    pub system_metrics_enabled: bool,
    pub brain_activity_enabled: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            is_monitoring: false,
            watched_projects: Vec::new(),
            system_metrics_enabled: true,
            brain_activity_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchedProject {
    pub path: String,
    pub name: String,
    pub stats: ProjectStats,
}

#[tauri::command]
pub fn get_system_metrics(monitor: State<'_, SharedSystemMonitor>) -> Result<SystemMetrics, String> {
    let mut monitor = monitor.write();
    Ok(monitor.collect_metrics())
}

#[tauri::command]
pub fn start_monitoring(
    app: AppHandle,
    monitor: State<'_, SharedSystemMonitor>,
    state: State<'_, parking_lot::RwLock<AppState>>,
) -> Result<(), String> {
    {
        let mut app_state = state.write();
        if app_state.is_monitoring {
            return Ok(());
        }
        app_state.is_monitoring = true;
    }

    let monitor_clone = monitor.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        loop {
            let is_monitoring = {
                let state = app.state::<parking_lot::RwLock<AppState>>();
                let s = state.read();
                s.is_monitoring
            };

            if !is_monitoring {
                break;
            }

            let metrics = {
                let mut mon = monitor_clone.write();
                mon.collect_metrics()
            };

            let _ = app_clone.emit("system-metrics", &metrics);

            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_monitoring(state: State<'_, parking_lot::RwLock<AppState>>) -> Result<(), String> {
    let mut app_state = state.write();
    app_state.is_monitoring = false;
    Ok(())
}

#[tauri::command]
pub fn watch_project(
    path: String,
    watcher: State<'_, SharedFileWatcher>,
    state: State<'_, parking_lot::RwLock<AppState>>,
) -> Result<ProjectStats, String> {
    let project_path = std::path::Path::new(&path);

    if !project_path.exists() {
        return Err("Path does not exist".to_string());
    }

    if !project_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let mut watcher = watcher.write();

    if let Err(e) = watcher.watch(project_path) {
        return Err(format!("Failed to watch path: {}", e));
    }

    let stats = watcher.scan_project(project_path);

    let mut app_state = state.write();
    if !app_state.watched_projects.contains(&path) {
        app_state.watched_projects.push(path.clone());
    }

    Ok(stats)
}

#[tauri::command]
pub fn unwatch_project(
    path: String,
    state: State<'_, parking_lot::RwLock<AppState>>,
) -> Result<(), String> {
    let mut app_state = state.write();
    app_state.watched_projects.retain(|p| p != &path);
    Ok(())
}

#[tauri::command]
pub fn get_project_stats(
    path: String,
    watcher: State<'_, SharedFileWatcher>,
) -> Result<ProjectStats, String> {
    let mut watcher = watcher.write();
    let project_path = std::path::Path::new(&path);
    Ok(watcher.scan_project(project_path))
}

#[tauri::command]
pub fn get_git_activity(
    path: String,
    watcher: State<'_, SharedFileWatcher>,
) -> Result<GitActivity, String> {
    let watcher = watcher.read();
    let project_path = std::path::Path::new(&path);

    watcher
        .get_git_activity(project_path)
        .ok_or_else(|| "Not a git repository".to_string())
}

#[tauri::command]
pub fn record_brain_activity(
    activity_type: String,
    region_id: String,
    intensity: f32,
    metadata: String,
    db: State<'_, SharedDatabase>,
) -> Result<(), String> {
    let db = db.read();

    let activity = BrainActivity {
        id: Uuid::new_v4().to_string(),
        activity_type,
        region_id,
        intensity,
        timestamp: Utc::now().to_rfc3339(),
        metadata,
    };

    db.record_brain_activity(&activity)
        .map_err(|e| format!("Failed to record activity: {}", e))
}

#[tauri::command]
pub fn get_recent_activity(
    limit: usize,
    db: State<'_, SharedDatabase>,
) -> Result<Vec<BrainActivity>, String> {
    let db = db.read();
    db.get_recent_activity(limit)
        .map_err(|e| format!("Failed to get recent activity: {}", e))
}

#[tauri::command]
pub fn add_memory_point(
    content: String,
    memory_type: String,
    tags: Vec<String>,
    source_path: Option<String>,
    db: State<'_, SharedDatabase>,
) -> Result<MemoryPoint, String> {
    let db = db.read();
    let now = Utc::now().to_rfc3339();

    let point = MemoryPoint {
        id: Uuid::new_v4().to_string(),
        content,
        memory_type,
        tags,
        source_path,
        created_at: now.clone(),
        accessed_at: now,
        access_count: 0,
        importance: 0.5,
        embedding: None,
    };

    db.add_memory_point(&point)
        .map_err(|e| format!("Failed to add memory point: {}", e))?;

    Ok(point)
}

#[tauri::command]
pub fn get_recent_memories(
    limit: usize,
    db: State<'_, SharedDatabase>,
) -> Result<Vec<MemoryPoint>, String> {
    let db = db.read();
    db.get_recent_memories(limit)
        .map_err(|e| format!("Failed to get recent memories: {}", e))
}

#[tauri::command]
pub fn save_project_context(
    project_path: String,
    project_name: String,
    language_stats: String,
    file_count: i32,
    total_lines: i64,
    git_branch: Option<String>,
    recent_files: String,
    db: State<'_, SharedDatabase>,
) -> Result<(), String> {
    let db = db.read();

    let context = ProjectContext {
        id: Uuid::new_v4().to_string(),
        project_path,
        project_name,
        language_stats,
        file_count,
        total_lines,
        last_indexed: Utc::now().to_rfc3339(),
        git_branch,
        recent_files,
    };

    db.save_project_context(&context)
        .map_err(|e| format!("Failed to save project context: {}", e))
}

#[tauri::command]
pub fn get_project_context(
    project_path: String,
    db: State<'_, SharedDatabase>,
) -> Result<Option<ProjectContext>, String> {
    let db = db.read();
    db.get_project_context(&project_path)
        .map_err(|e| format!("Failed to get project context: {}", e))
}

#[tauri::command]
pub fn get_app_state(state: State<'_, parking_lot::RwLock<AppState>>) -> AppState {
    state.read().clone()
}

#[tauri::command]
pub fn toggle_system_metrics(
    enabled: bool,
    state: State<'_, parking_lot::RwLock<AppState>>,
) -> Result<(), String> {
    let mut app_state = state.write();
    app_state.system_metrics_enabled = enabled;
    Ok(())
}

#[tauri::command]
pub fn toggle_brain_activity(
    enabled: bool,
    state: State<'_, parking_lot::RwLock<AppState>>,
) -> Result<(), String> {
    let mut app_state = state.write();
    app_state.brain_activity_enabled = enabled;
    Ok(())
}