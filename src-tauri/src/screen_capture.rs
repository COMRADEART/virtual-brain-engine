use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenCaptureResult {
    pub success: bool,
    pub width: u32,
    pub height: u32,
    pub timestamp: i64,
    pub monitor_index: u32,
    pub image_data: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveWindowInfo {
    pub title: String,
    pub app_name: String,
    pub process_id: u32,
    pub bounds: Option<WindowBounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionConfig {
    pub enabled: bool,
    pub capture_interval_ms: u32,
    pub observation_scope: String,
    pub exclude_apps: Vec<String>,
    pub include_apps: Vec<String>,
    pub private_window_exclusion: bool,
    pub max_memory_age_days: u32,
    pub require_explicit_capture: bool,
}

impl Default for VisionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            capture_interval_ms: 5000,
            observation_scope: "all".to_string(),
            exclude_apps: Vec::new(),
            include_apps: Vec::new(),
            private_window_exclusion: true,
            max_memory_age_days: 7,
            require_explicit_capture: true,
        }
    }
}

pub fn get_app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn get_visual_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = get_app_data_dir(app).join("visual");
    std::fs::create_dir_all(&dir).ok();
    dir
}

#[tauri::command]
pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("Failed to get screens: {}", e))?;

    let monitors: Vec<MonitorInfo> = screens
        .iter()
        .enumerate()
        .map(|(i, screen)| {
            let info = screen.display_info;
            MonitorInfo {
                index: i as u32,
                width: info.width,
                height: info.height,
                x: info.x,
                y: info.y,
                is_primary: info.is_primary,
                name: info.name.clone().unwrap_or_else(|| format!("Monitor {}", i)),
            }
        })
        .collect();

    Ok(monitors)
}

#[tauri::command]
pub fn capture_screen(monitor_index: Option<u32>, app: tauri::AppHandle) -> Result<ScreenCaptureResult, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("Failed to get screens: {}", e))?;

    let screen = if let Some(idx) = monitor_index {
        screens
            .get(idx as usize)
            .ok_or_else(|| format!("Monitor {} not found", idx))?
    } else {
        screens
            .first()
            .ok_or_else(|| "No monitors found".to_string())?
    };

    let timestamp = Utc::now().timestamp_millis();

    let capture = screen
        .capture()
        .map_err(|e| format!("Failed to capture screen: {}", e))?;

    let width = capture.width();
    let height = capture.height();

    let rgba_pixels: Vec<u8> = capture.into_raw();

    let mut png_data: Vec<u8> = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png_data);
        let encoder = png::Encoder::new(&mut cursor, width, height);
        let encoder = encoder.write_header().map_err(|e| format!("PNG encoder error: {}", e))?;
        encoder
            .write_image_data(&rgba_pixels)
            .map_err(|e| format!("Failed to write PNG data: {}", e))?;
    }

    let base64_image = BASE64.encode(&png_data);

    let visual_dir = get_visual_dir(&app);
    let filename = format!("capture_{}.png", timestamp);
    let filepath = visual_dir.join(&filename);

    if let Ok(bytes) = BASE64.decode(&base64_image) {
        if let Some(png_bytes) = try_decode_png(&bytes) {
            let _ = std::fs::write(&filepath, &png_bytes);
        }
    }

    Ok(ScreenCaptureResult {
        success: true,
        width,
        height,
        timestamp,
        monitor_index: monitor_index.unwrap_or(0),
        image_data: Some(base64_image),
        error: None,
    })
}

fn try_decode_png(data: &[u8]) -> Option<Vec<u8>> {
    let decoder = png::Decoder::new(std::io::Cursor::new(data));
    if let Ok(mut reader) = decoder.read_info() {
        let mut buf = vec![0; reader.output_buffer_size()];
        if let Ok(_) = reader.next_frame(&mut buf) {
            return Some(buf);
        }
    }
    None
}

#[tauri::command]
pub fn get_screen_capture_path(capture_id: String, app: tauri::AppHandle) -> Result<Option<String>, String> {
    let visual_dir = get_visual_dir(&app);
    let filename = format!("capture_{}.png", capture_id);
    let filepath = visual_dir.join(&filename);

    if filepath.exists() {
        filepath.to_str().map(|s| s.to_string()).ok_or_else(|| "Invalid path".to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn list_screen_captures(app: tauri::AppHandle, limit: Option<u32>) -> Result<Vec<CaptureMetadata>, String> {
    let visual_dir = get_visual_dir(&app);
    let limit = limit.unwrap_or(50) as usize;

    let mut captures: Vec<CaptureMetadata> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&visual_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "png").unwrap_or(false) {
                if let Some(filename) = path.file_stem().and_then(|n| n.to_str()) {
                    if filename.starts_with("capture_") {
                        if let Ok(metadata) = std::fs::metadata(&path) {
                            if let Ok(created) = metadata.created() {
                                let timestamp = filename
                                    .trim_start_matches("capture_")
                                    .parse::<i64>()
                                    .unwrap_or(0);

                                captures.push(CaptureMetadata {
                                    id: filename.replace("capture_", ""),
                                    filename: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                                    size_bytes: metadata.len() as u64,
                                    created_at: chrono::DateTime::from(created).timestamp_millis(),
                                    width: 0,
                                    height: 0,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    captures.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    captures.truncate(limit);

    Ok(captures)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureMetadata {
    pub id: String,
    pub filename: String,
    pub size_bytes: u64,
    pub created_at: i64,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn delete_screen_capture(capture_id: String, app: tauri::AppHandle) -> Result<bool, String> {
    let visual_dir = get_visual_dir(&app);
    let filename = format!("capture_{}.png", capture_id);
    let filepath = visual_dir.join(&filename);

    if filepath.exists() {
        std::fs::remove_file(&filepath)
            .map_err(|e| format!("Failed to delete capture: {}", e))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn get_vision_config(app: tauri::AppHandle) -> Result<VisionConfig, String> {
    let config_dir = get_app_data_dir(&app);
    let config_path = config_dir.join("vision_config.json");

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read vision config: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse vision config: {}", e))
    } else {
        Ok(VisionConfig::default())
    }
}

#[tauri::command]
pub fn save_vision_config(config: VisionConfig, app: tauri::AppHandle) -> Result<(), String> {
    let config_dir = get_app_data_dir(&app);
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    let config_path = config_dir.join("vision_config.json");

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize vision config: {}", e))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write vision config: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn capture_region(x: i32, y: i32, width: u32, height: u32, app: tauri::AppHandle) -> Result<ScreenCaptureResult, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("Failed to get screens: {}", e))?;

    let screen = screens
        .first()
        .ok_or_else(|| "No monitors found".to_string())?;

    let timestamp = Utc::now().timestamp_millis();

    let capture = screen
        .capture_area(x, y, width, height)
        .map_err(|e| format!("Failed to capture region: {}", e))?;

    let cap_width = capture.width();
    let cap_height = capture.height();

    let rgba_pixels: Vec<u8> = capture.into_raw();

    let mut png_data: Vec<u8> = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png_data);
        let encoder = png::Encoder::new(&mut cursor, cap_width, cap_height);
        let encoder = encoder.write_header().map_err(|e| format!("PNG encoder error: {}", e))?;
        encoder
            .write_image_data(&rgba_pixels)
            .map_err(|e| format!("Failed to write PNG data: {}", e))?;
    }

    let base64_image = BASE64.encode(&png_data);

    let visual_dir = get_visual_dir(&app);
    let filename = format!("region_{}_{}_{}_{}_{}.png", x, y, width, height, timestamp);
    let filepath = visual_dir.join(&filename);

    if let Ok(bytes) = BASE64.decode(&base64_image) {
        if let Some(_png_bytes) = try_decode_png(&bytes) {
            let _ = std::fs::write(&filepath, &png_bytes);
        }
    }

    Ok(ScreenCaptureResult {
        success: true,
        width: cap_width,
        height: cap_height,
        timestamp,
        monitor_index: 0,
        image_data: Some(base64_image),
        error: None,
    })
}