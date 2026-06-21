// Observability spine — self-telemetry contracts. Zero runtime deps (pure types
// + a const), importable by both the Node server and the Vite client.

export interface VitalSample {
  metric: string;
  value: number;
  capturedAt: string;
}

export interface DiagnosticEntry {
  source: string;
  level: "warn" | "error";
  message: string;
  count: number; // running count for this source at capture time
  createdAt: string;
}

export interface HistogramStat {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramStat>;
}

// GET /api/brain/vitals response.
export interface BrainVitalsResponse {
  metrics: MetricsSnapshot;
  series: VitalSample[];
  diagnostics: DiagnosticEntry[];
}
