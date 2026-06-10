// Model usage telemetry: one row per /api/ask response. Tracks which model
// served, which provider (local/remote), latency, step timings, whether remote
// fallback was triggered, and the key index used (for rotation visibility).
// Also handles routing log (which MoE profile was chosen) and aggregation
// queries for the Model Performance dashboard.

import { setAssignment } from "../../reasoning/modelRouting.js";

import { ulid } from "ulid";
import { openDb } from "../sqlite.js";

// ── Usage log ───────────────────────────────────────────────────────────────

export interface StepTimings {
  memory_ms?: number;
  reasoning_ms?: number;
  error_ms?: number;
  response_ms?: number;
  retry_count?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_variant?: string;
}

export interface ModelUsageEntry {
  id: string;
  runId: string;
  connectorId: string;
  provider: "local" | "remote";
  model: string;
  keyIndex: number | null;
  fallback: boolean;
  latencyMs: number;
  stepTimings: StepTimings | null;
  error: string | null;
  createdAt: string;
}

export function logModelUsage(entry: Omit<ModelUsageEntry, "id" | "createdAt">): void {
  const db = openDb();
  const stepTimingsJson = entry.stepTimings ? JSON.stringify(entry.stepTimings) : null;
  db.prepare(
    `INSERT INTO usage_log (id, run_id, connector_id, provider, model, key_index, fallback, latency_ms, step_timings, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    entry.runId,
    entry.connectorId,
    entry.provider,
    entry.model,
    entry.keyIndex,
    entry.fallback ? 1 : 0,
    entry.latencyMs,
    stepTimingsJson,
    entry.error,
    new Date().toISOString(),
  );
}

export interface ModelUsageSummary {
  totalRuns: number;
  localRuns: number;
  remoteRuns: number;
  fallbackRuns: number;
  recentRuns: ModelUsageEntry[];
}

export function getModelUsage(limit = 20): ModelUsageSummary {
  const db = openDb();
  const recent = db
    .prepare<[number], { id: string; run_id: string; connector_id: string; provider: string; model: string; key_index: number | null; fallback: number; latency_ms: number; step_timings: string | null; error: string | null; created_at: string }>(
      `SELECT id, run_id, connector_id, provider, model, key_index, fallback, latency_ms, step_timings, error, created_at
       FROM usage_log ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({
      id: r.id,
      runId: r.run_id,
      connectorId: r.connector_id,
      provider: r.provider as "local" | "remote",
      model: r.model,
      keyIndex: r.key_index,
      fallback: r.fallback === 1,
      latencyMs: r.latency_ms,
      stepTimings: r.step_timings ? (JSON.parse(r.step_timings) as StepTimings) : null,
      error: r.error,
      createdAt: r.created_at,
    }));

  const totals = db
    .prepare<[], { provider: string; fallback: number; c: number }>(
      `SELECT provider, fallback, count(*) AS c FROM usage_log GROUP BY provider, fallback`,
    )
    .all();

  let localRuns = 0;
  let remoteRuns = 0;
  let fallbackRuns = 0;
  for (const row of totals) {
    if (row.provider === "local") localRuns += row.c;
    else remoteRuns += row.c;
    if (row.fallback === 1) fallbackRuns += row.c;
  }

  return {
    totalRuns: localRuns + remoteRuns,
    localRuns,
    remoteRuns,
    fallbackRuns,
    recentRuns: recent,
  };
}

// ── Model performance stats (Option B) ──────────────────────────────────────

export interface ModelStats {
  model: string;
  provider: string;
  runs: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  errorRate: number;
  fallbackRate: number;
  avgStepTimings: StepTimings;
}

export interface ModelPerformanceStats {
  models: ModelStats[];
  overall: {
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    errorRate: number;
    queryDepthDistribution: { shallow: number; full: number };
  };
}

export function getModelPerformanceStats(days?: number): ModelPerformanceStats {
  const db = openDb();
  const timeFilter = days ? `WHERE created_at > datetime('now', '-' || ${days} || ' days')` : "";

  // Per-model aggregation
  const models = db
    .prepare<[], { model: string; provider: string; runs: number; avg_latency: number; min_latency: number; max_latency: number; errors: number; fallbacks: number }>(
      `SELECT model, provider, COUNT(*) AS runs,
              AVG(latency_ms) AS avg_latency,
              MIN(latency_ms) AS min_latency,
              MAX(latency_ms) AS max_latency,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN fallback = 1 THEN 1 ELSE 0 END) AS fallbacks
       FROM usage_log
       ${timeFilter}
       GROUP BY model, provider
       ORDER BY runs DESC`,
    )
    .all()
    .map((r) => {
      // Compute average step timings for this model
      const stepRows = db
        .prepare<[string], { step_timings: string | null }>(
          `SELECT step_timings FROM usage_log WHERE model = ? AND step_timings IS NOT NULL ${days ? `AND created_at > datetime('now', '-' || ${days} || ' days')` : ""}`,
        )
        .all(r.model);
      const avgSteps: StepTimings = {};
      const counts = { memory_ms: 0, reasoning_ms: 0, error_ms: 0, response_ms: 0 };
      const sums = { memory_ms: 0, reasoning_ms: 0, error_ms: 0, response_ms: 0 };
      for (const sr of stepRows) {
        if (!sr.step_timings) continue;
        try {
          const parsed = JSON.parse(sr.step_timings) as StepTimings;
          for (const key of ["memory_ms", "reasoning_ms", "error_ms", "response_ms"] as const) {
            if (typeof parsed[key] === "number") {
              sums[key] += parsed[key];
              counts[key]++;
            }
          }
        } catch { /* skip malformed */ }
      }
      for (const key of ["memory_ms", "reasoning_ms", "error_ms", "response_ms"] as const) {
        if (counts[key] > 0) avgSteps[key] = Math.round(sums[key] / counts[key]);
      }
      return {
        model: r.model,
        provider: r.provider,
        runs: r.runs,
        avgLatencyMs: Math.round(r.avg_latency),
        minLatencyMs: r.min_latency,
        maxLatencyMs: r.max_latency,
        errorRate: r.runs > 0 ? r.errors / r.runs : 0,
        fallbackRate: r.runs > 0 ? r.fallbacks / r.runs : 0,
        avgStepTimings: avgSteps,
      };
    });

  // Overall stats
  const overallRow = db
    .prepare<[], { avg_latency: number; errors: number; total: number }>(
      `SELECT AVG(latency_ms) AS avg_latency,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
              COUNT(*) AS total
       FROM usage_log
       ${timeFilter}`,
    )
    .get();

  // P50 and P95 via window function
  const percentiles = db
    .prepare<[], { p50: number; p95: number }>(
      `SELECT
         (SELECT latency_ms FROM usage_log ${timeFilter} ORDER BY latency_ms LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM usage_log ${timeFilter})) AS p50,
         (SELECT latency_ms FROM usage_log ${timeFilter} ORDER BY latency_ms LIMIT 1 OFFSET (SELECT CAST(COUNT(*)*0.95 AS INT) FROM usage_log ${timeFilter})) AS p95`,
    )
    .get();

  return {
    models,
    overall: {
      avgLatencyMs: Math.round(overallRow?.avg_latency ?? 0),
      p50LatencyMs: percentiles?.p50 ?? 0,
      p95LatencyMs: percentiles?.p95 ?? 0,
      errorRate: overallRow && overallRow.total > 0 ? overallRow.errors / overallRow.total : 0,
      queryDepthDistribution: { shallow: 0, full: 0 }, // populated by routing_log
    },
  };
}

// ── Routing log (Option C) ──────────────────────────────────────────────────

export interface RoutingLogEntry {
  id: string;
  runId: string;
  profile: string;
  model: string | null;
  experts: string;
  difficulty: number;
  depth: string;
  citedCount: number;
  retrievedCount: number;
  confidence: number;
  latencyMs: number;
  createdAt: string;
}

export interface RoutingInsight {
  profile: string;
  model: string | null;
  runs: number;
  avgCitations: number;
  avgConfidence: number;
  avgLatencyMs: number;
  qualityScore: number; // citations × confidence / latency (higher = better)
}

export function logRouting(entry: Omit<RoutingLogEntry, "id" | "createdAt">): void {
  const db = openDb();
  db.prepare(
    `INSERT INTO routing_log (id, run_id, profile, model, experts, difficulty, depth, cited_count, retrieved_count, confidence, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    entry.runId,
    entry.profile,
    entry.model,
    entry.experts,
    entry.difficulty,
    entry.depth,
    entry.citedCount,
    entry.retrievedCount,
    entry.confidence,
    entry.latencyMs,
    new Date().toISOString(),
  );
}

export function updateRoutingProfile(profile: string, model: string): void {
  setAssignment(profile as any, model);
}

export function getRoutingInsights(): RoutingInsight[] {
  const db = openDb();
  return db
    .prepare<[], { profile: string; model: string | null; runs: number; avg_citations: number; avg_confidence: number; avg_latency: number }>(
      `SELECT profile, model, COUNT(*) AS runs,
              AVG(cited_count) AS avg_citations,
              AVG(confidence) AS avg_confidence,
              AVG(latency_ms) AS avg_latency
       FROM routing_log
       GROUP BY profile, model
       ORDER BY runs DESC`,
    )
    .all()
    .map((r) => ({
      profile: r.profile,
      model: r.model,
      runs: r.runs,
      avgCitations: Math.round(r.avg_citations * 100) / 100,
      avgConfidence: Math.round(r.avg_confidence * 100) / 100,
      avgLatencyMs: Math.round(r.avg_latency),
      // Quality: higher citations + higher confidence + lower latency = better
      qualityScore: r.avg_latency > 0
        ? Math.round(((r.avg_citations * r.avg_confidence) / (r.avg_latency / 1000)) * 100) / 100
        : 0,
    }));
}
export interface ProfileSuggestion {
  profile: string;
  currentModel: string | null;
  suggestedModel: string;
  currentRuns: number;
  suggestedRuns: number;
  qualityDelta: number;
  reason: string;
  improvement: number;
}

export function getProfileSuggestions(): ProfileSuggestion[] {
  const insights = getRoutingInsights();
  const suggestions: ProfileSuggestion[] = [];

  // Group by profile, find best model per profile
  const byProfile = new Map<string, RoutingInsight[]>();

  for (const insight of insights) {
    const list = byProfile.get(insight.profile) ?? [];
    list.push(insight);
    byProfile.set(insight.profile, list);
  }

  for (const [profile, runs] of byProfile) {
    if (runs.length < 2) continue;
    const sorted = [...runs].sort((a, b) => b.qualityScore - a.qualityScore);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best === worst) continue;
    if (best.qualityScore <= worst.qualityScore) continue;

    suggestions.push({
      profile,
      currentModel: worst.model,
      suggestedModel: best.model ?? "connector default",
      currentRuns: worst.runs,
      suggestedRuns: best.runs,
      qualityDelta: Math.round((best.qualityScore - worst.qualityScore) * 100) / 100,
      reason: `"${best.model ?? "default"}" scores ${(best.qualityScore).toFixed(1)} vs ${(worst.qualityScore).toFixed(1)} on "${profile}" profile (${best.runs} runs)`,
      improvement: Math.round((best.qualityScore - worst.qualityScore) * 100) / 100,
    });
  }

  return suggestions.sort((a, b) => b.improvement - a.improvement);
}

// ── Retention cleanup ───────────────────────────────────────────────────────

export function cleanupUsageLog(maxAgeDays: number): { usageDeleted: number; routingDeleted: number } {
  const db = openDb();
  const usageResult = db.prepare(
    `DELETE FROM usage_log WHERE created_at < datetime('now', '-' || ? || ' days')`,
  ).run(maxAgeDays);
  const routingResult = db.prepare(
    `DELETE FROM routing_log WHERE created_at < datetime('now', '-' || ? || ' days')`,
  ).run(maxAgeDays);
  return { usageDeleted: usageResult.changes, routingDeleted: routingResult.changes };
}

// ── Per-key stats ──────────────────────────────────────────────────────────

export interface KeyStats {
  keyIndex: number;
  runs: number;
  avgLatencyMs: number;
  errors: number;
  errorRate: number;
}

export function getKeyStats(): KeyStats[] {
  const db = openDb();
  return db
    .prepare<[], { key_index: number; runs: number; avg_latency: number; errors: number }>(
      `SELECT key_index, COUNT(*) AS runs, AVG(latency_ms) AS avg_latency,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
       FROM usage_log WHERE key_index IS NOT NULL
       GROUP BY key_index ORDER BY key_index`,
    )
    .all()
    .map((r) => ({
      keyIndex: r.key_index,
      runs: r.runs,
      avgLatencyMs: Math.round(r.avg_latency),
      errors: r.errors,
      errorRate: r.runs > 0 ? r.errors / r.runs : 0,
    }));
}

// ── Confidence calibration ─────────────────────────────────────────────────

export interface CalibrationBucket {
  bucket: number;
  avgCitations: number;
  runs: number;
}

export function getConfidenceCalibration(): CalibrationBucket[] {
  const db = openDb();
  return db
    .prepare<[], { bucket: number; avg_citations: number; runs: number }>(
      `SELECT ROUND(confidence * 10) / 10.0 AS bucket,
              AVG(cited_count) AS avg_citations,
              COUNT(*) AS runs
       FROM routing_log
       GROUP BY bucket ORDER BY bucket`,
    )
    .all()
    .map((r) => ({
      bucket: r.bucket,
      avgCitations: Math.round(r.avg_citations * 100) / 100,
      runs: r.runs,
    }));
}

// ── Search quality ─────────────────────────────────────────────────────────

export interface SearchQualityStats {
  avgRetrieved: number;
  avgCited: number;
  citationRate: number;
  runs: number;
}

export function getSearchQuality(): SearchQualityStats {
  const db = openDb();
  const row = db.prepare<[], { avg_retrieved: number; avg_cited: number; runs: number }>(
    `SELECT AVG(retrieved_count) AS avg_retrieved, AVG(cited_count) AS avg_cited, COUNT(*) AS runs
     FROM routing_log WHERE retrieved_count > 0`,
  ).get();
  if (!row || !row.runs) return { avgRetrieved: 0, avgCited: 0, citationRate: 0, runs: 0 };
  return {
    avgRetrieved: Math.round(row.avg_retrieved * 10) / 10,
    avgCited: Math.round(row.avg_cited * 10) / 10,
    citationRate: row.avg_retrieved > 0 ? row.avg_cited / row.avg_retrieved : 0,
    runs: row.runs,
  };
}

// ── Connector health ───────────────────────────────────────────────────────

export interface ConnectorHealthEntry {
  connectorId: string;
  runs: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  lastUsedAt: string | null;
}

export function getConnectorHealth(): ConnectorHealthEntry[] {
  const db = openDb();
  return db
    .prepare<
      [],
      { connector_id: string; runs: number; errors: number; avg_latency: number; last_used: string | null }
    >(
      `SELECT connector_id,
              COUNT(*) AS runs,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency,
              MAX(created_at) AS last_used
       FROM usage_log
       GROUP BY connector_id ORDER BY runs DESC`,
    )
    .all()
    .map((r) => ({
      connectorId: r.connector_id,
      runs: r.runs,
      errors: r.errors,
      errorRate: r.runs > 0 ? r.errors / r.runs : 0,
      avgLatencyMs: Math.round(r.avg_latency),
      lastUsedAt: r.last_used,
    }));
}

// ── Telemetry buffer (batched writes) ──────────────────────────────────────

export class TelemetryBuffer {
  private buffer: Omit<ModelUsageEntry, "id" | "createdAt">[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;

  constructor(maxBatchSize = 10, flushIntervalMs = 5000) {
    this.maxBatchSize = maxBatchSize;
    this.flushIntervalMs = flushIntervalMs;
  }

  push(entry: Omit<ModelUsageEntry, "id" | "createdAt">): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const db = openDb();
    const ins = db.prepare(
      `INSERT INTO usage_log (id, run_id, connector_id, provider, model, key_index, latency_ms, fallback, retry_count, step_timings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const e of batch) {
        ins.run(
          ulid(), e.runId, e.connectorId, e.provider, e.model, e.keyIndex ?? null,
          e.latencyMs, e.fallback ? 1 : 0, e.stepTimings?.retry_count ?? null,
          e.stepTimings ? JSON.stringify(e.stepTimings) : null, now,
        );
      }
    });
    tx();
  }

  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  stopAutoFlush(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
  }
}
