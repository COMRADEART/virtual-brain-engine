import type { ScreenCapture } from "../../../shared/vision.js";
import type { CaptureOptions } from "./types.js";

const MONITOR_INDEX_MAIN = 0;

export async function captureScreen(options: CaptureOptions = {}): Promise<ScreenCapture> {
  return {
    success: false,
    width: 0,
    height: 0,
    timestamp: Date.now(),
    monitorIndex: options.monitorIndex ?? MONITOR_INDEX_MAIN,
    imageData: null,
    error: "Screen capture must be initiated from the frontend via Tauri command. Use POST /api/vision/capture with capture data.",
  };
}

export async function captureRegion(
  x: number,
  y: number,
  width: number,
  height: number
): Promise<ScreenCapture> {
  return {
    success: false,
    width,
    height,
    timestamp: Date.now(),
    monitorIndex: 0,
    imageData: null,
    error: "Screen capture must be initiated from the frontend via Tauri command. Use POST /api/vision/capture/region with capture data.",
  };
}

export interface MonitorInfo {
  index: number;
  width: number;
  height: number;
  x: number;
  y: number;
  is_primary: boolean;
  name: string;
}

export async function getMonitors(): Promise<MonitorInfo[]> {
  return [];
}

export interface VisionConfig {
  enabled: boolean;
  capture_interval_ms: number;
  observation_scope: string;
  exclude_apps: string[];
  include_apps: string[];
  private_window_exclusion: boolean;
  max_memory_age_days: number;
  require_explicit_capture: boolean;
}

export async function getVisionConfig(): Promise<VisionConfig | null> {
  return null;
}

export async function saveVisionConfig(config: VisionConfig): Promise<boolean> {
  return false;
}