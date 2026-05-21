export interface CaptureOptions {
  monitorIndex?: number;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface VisionState {
  enabled: boolean;
  lastCapture: number;
  activeWindow: string | null;
  captureCount: number;
}

export interface OCRResult {
  text: string;
  confidence: number;
  regions: OCRTextRegion[];
}

export interface OCRTextRegion {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface UIDetectionResult {
  regions: DetectedUIRegion[];
  overallState: string;
  confidence: number;
}

export interface DetectedUIRegion {
  type: UIElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  confidence: number;
  app?: string;
}

export type UIElementType =
  | "window"
  | "title_bar"
  | "menu_bar"
  | "toolbar"
  | "sidebar"
  | "panel"
  | "tab"
  | "button"
  | "input"
  | "text"
  | "list"
  | "tree"
  | "table"
  | "dialog"
  | "popup"
  | "notification"
  | "terminal"
  | "editor"
  | "terminal_output"
  | "status_bar"
  | "icon"
  | "browser"
  | "settings"
  | "unknown";

export interface WorkflowTransition {
  fromState: string;
  toState: string;
  trigger: string;
  timestamp: number;
  screenshotId: string | null;
}

export interface VisionSettings {
  captureIntervalMs: number;
  maxMemoryAgeDays: number;
  privateWindowExclusion: boolean;
  observationScope: "all" | "specific-apps" | "exclude-apps";
  excludeApps: string[];
  includeApps: string[];
}