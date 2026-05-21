export interface VisualMemory {
  id: string;
  screenshotPath: string;
  thumbnailPath: string | null;
  width: number;
  height: number;
  captureTimestamp: number;
  sourceApp: string | null;
  windowTitle: string | null;
  monitorIndex: number;
  hash: string;
  tags: string[];
  annotation: string | null;
  linkedMemoryIds: string[];
  createdAt: string;
}

export interface VisualRegion {
  id: string;
  visualMemoryId: string;
  regionType: VisualRegionType;
  boundingBox: BoundingBox;
  confidence: number;
  detectedText: string | null;
  detectedApp: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type VisualRegionType =
  | "window"
  | "panel"
  | "button"
  | "text"
  | "diagram"
  | "terminal"
  | "ide"
  | "browser"
  | "unknown";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualWorkflowState {
  id: string;
  name: string;
  entryScreenshotId: string | null;
  exitScreenshotId: string | null;
  transitionTrigger: string | null;
  frequency: number;
  avgDurationMs: number | null;
  tags: string[];
  createdAt: string;
}

export interface WindowInfo {
  title: string;
  appName: string;
  processId: number;
  bounds: BoundingBox | null;
}

export interface UIState {
  type: UIStateType;
  confidence: number;
  detail: string;
  regions: VisualRegion[];
  suggestedAction: string | null;
}

export type UIStateType =
  | "idle"
  | "coding"
  | "build_running"
  | "build_error"
  | "test_running"
  | "test_failure"
  | "debugging"
  | "browser"
  | "terminal"
  | "file_explorer"
  | "settings"
  | "error_dialog"
  | "notification"
  | "unknown";

export interface VisualKnowledgeNode {
  id: string;
  type: VisualRegionType;
  app: string;
  position: BoundingBox;
  text?: string;
  children: string[];
  parent: string | null;
  captureId: string;
  timestamp: number;
}

export interface VisualKnowledgeEdge {
  source: string;
  target: string;
  relation: VisualEdgeRelation;
  weight: number;
}

export type VisualEdgeRelation =
  | "contains"
  | "overlaps"
  | "follows"
  | "triggers"
  | "associated_with";

export interface VisualKnowledgeGraph {
  nodes: Map<string, VisualKnowledgeNode>;
  edges: VisualKnowledgeEdge[];
  lastCaptureId: string;
  activeWindowId: string | null;
}

export interface ScreenCapture {
  success: boolean;
  width: number;
  height: number;
  timestamp: number;
  monitorIndex: number;
  imageData: string | null;
  error: string | null;
}

export interface VisionConfig {
  enabled: boolean;
  captureIntervalMs: number;
  observationScope: "all" | "specific-apps" | "exclude-apps";
  excludeApps: string[];
  includeApps: string[];
  privateWindowExclusion: boolean;
  maxMemoryAgeDays: number;
  requireExplicitCapture: boolean;
}

export interface VisualSearchQuery {
  text?: string;
  app?: string;
  regionType?: VisualRegionType;
  timeRange?: { start: number; end: number };
  limit?: number;
  offset?: number;
}

export interface VisualSearchResult {
  memory: VisualMemory;
  regions: VisualRegion[];
  relevanceScore: number;
}

export type BrainBusVisualMessage =
  | { type: "screen-captured"; capture: ScreenCapture }
  | { type: "visual-memory-created"; memory: VisualMemory }
  | { type: "visual-regions-detected"; regions: VisualRegion[]; memoryId: string }
  | { type: "window-changed"; info: WindowInfo }
  | { type: "workflow-detected"; workflow: VisualWorkflowState }
  | { type: "ui-state-detected"; state: UIState }
  | { type: "visual-knowledge-updated"; graph: VisualKnowledgeGraph }
  | { type: "visual-query-result"; results: VisualSearchResult[] }
  | { type: "vision-enabled"; enabled: boolean }
  | { type: "vision-error"; error: string };