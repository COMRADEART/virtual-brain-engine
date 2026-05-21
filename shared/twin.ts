// Digital Twin — shared type definitions. Imported by both the Vite frontend
// (src/...) and the Express server (server/src/...). ZERO runtime deps — pure
// type declarations + plain constants, like the rest of shared/.
//
// Honesty contract (see DIGITAL_TWIN_SPEC.md §2): every metric the Node
// `os`-only telemetry source cannot supply is `number | null` — never `0`,
// never optional-with-default. The dashboard renders `null` as "—" so a user
// never sees a fabricated reading.

/** Per-snapshot hardware layer. */
export interface HardwareState {
  cpuPct: number; // 0-100, derived from os.cpus() time deltas
  cores: number;
  cpuModel: string;
  loadAvg1: number | null; // null on Windows (os.loadavg() === [0,0,0])
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number | null; // fs.statfs on the data dir; null if unsupported
  diskTotalBytes: number | null;
  uptimeSec: number;
  procRssBytes: number; // the brain's own process footprint
  gpuTempC: number | null; // always null under the os-only contract
  cpuTempC: number | null; // always null under the os-only contract
  batteryPct: number | null; // always null under the os-only contract
}

/** Per-snapshot software layer. */
export interface SoftwareState {
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  connectors: Array<{ id: string; kind: string; state: string; isDefault: boolean }>;
  agents: Array<{ name: string; capabilities: string[] }>;
}

/** Per-snapshot workflow layer. */
export interface WorkflowState {
  activeRuns: number;
  recentRuns: Array<{ id: string; status: string; startedAt: string }>;
  recentActions: Array<{ agent: string; action: string; at: string }>;
  recurringPatterns: number; // count from memory_sequence_patterns
}

/** Per-snapshot cognitive layer. */
export interface CognitiveTwinState {
  activeConversationId: string | null;
  lastMessageAt: string | null;
  recentMemoryAccess: number; // memory_access_log rows in the recent window
  agentActivity: Array<{ agent: string; state: string; at: string }>;
  focus: number; // 0-1 heuristic from access concentration
}

/** Per-snapshot project layer. */
export interface ProjectTwinState {
  projects: Array<{
    name: string;
    fileCount: number;
    languages: string[]; // top file extensions, most-common first
    lastActivityAt: string | null;
  }>;
}

/** A single captured Digital Twin snapshot. */
export interface TwinSnapshot {
  id: string; // ULID
  capturedAt: string; // ISO
  healthScore: number; // 0-1 composite
  hardware: HardwareState;
  software: SoftwareState;
  workflow: WorkflowState;
  cognitive: CognitiveTwinState;
  project: ProjectTwinState;
}

export type TwinAnomalyKind =
  | "cpu-spike"
  | "mem-pressure"
  | "disk-pressure"
  | "workflow-failure-spike"
  | "automation-loop";

export type TwinAnomalySeverity = "info" | "warn" | "critical";

export interface TwinAnomaly {
  id: string;
  detectedAt: string;
  kind: TwinAnomalyKind;
  severity: TwinAnomalySeverity;
  metric: string;
  value: number;
  baseline: number;
  detail: string;
}

export type TwinPredictionMetric =
  | "cpuPct"
  | "memUsedBytes"
  | "diskUsedBytes"
  | "workflow-failure";

export interface TwinPrediction {
  metric: TwinPredictionMetric;
  horizonMin: number;
  predicted: number;
  confidence: number; // 0-1
  reason: string;
}

export interface SimulationResult {
  action: string;
  predictedImpact: string;
  riskScore: number; // 0-1
  estimatedRuntimeMs: number;
  conflicts: string[];
  rollbackRecommendation: string;
}

/** Aggregate payload returned by GET /api/twin. */
export interface TwinView {
  snapshot: TwinSnapshot | null;
  anomalies: TwinAnomaly[];
  predictions: TwinPrediction[];
}
