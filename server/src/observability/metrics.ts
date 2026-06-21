// In-process metrics registry — counters, gauges, and bounded histograms. PURE
// (no I/O, no DB): any subsystem records into module-level maps, and the
// observability spine snapshots them into brain_vitals + the /api/brain/metrics
// route. Deliberately tiny and dependency-free — the goal is "the brain can see
// its own vitals", not a Prometheus port. Histograms keep only the newest
// HIST_CAP samples (bounded memory), enough for a p50/p95/max read.
//
// ponytail: percentiles are computed over an in-memory ring per metric, reset on
// restart. The persisted brain_vitals time-series (sampled on the brainCore
// tick) is the durable longitudinal record; this registry is the live snapshot.

import type { MetricsSnapshot, HistogramStat } from "../../../shared/observability.js";

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const histograms = new Map<string, number[]>();
const HIST_CAP = 256;

export function incr(name: string, by = 1): void {
  if (!Number.isFinite(by)) return;
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function gauge(name: string, value: number): void {
  if (Number.isFinite(value)) gauges.set(name, value);
}

export function observe(name: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const arr = histograms.get(name) ?? [];
  arr.push(value);
  if (arr.length > HIST_CAP) arr.shift();
  histograms.set(name, arr);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function snapshot(): MetricsSnapshot {
  const hist: Record<string, HistogramStat> = {};
  for (const [name, arr] of histograms) {
    const sorted = [...arr].sort((a, b) => a - b);
    hist[name] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    };
  }
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    histograms: hist,
  };
}

export function resetMetricsForTest(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}
