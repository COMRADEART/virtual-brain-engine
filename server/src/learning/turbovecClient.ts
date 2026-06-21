// Typed HTTP client for the optional turbovec vector index on the Python worker
// sidecar. Same boundary contract as the perception / airllm / own-model clients:
// the server MUST run with the worker down. Every method returns a structured
// result rather than throwing; an absent/old worker degrades to state:"unavailable"
// / { ok:false }.
//
// turbovec (TurboQuant, ~16x compression at 2-bit, SIMD ARM/x86) is an ALTERNATIVE
// to the in-process sqlite-vec index. OFF by default (CONFIG.turbovecEnabled); the
// pipeline's vectorSearch() branches to it only when enabled + available, and falls
// back to sqlite-vec on any error. The index is keyed by memory_points.embedding_id
// (the integer rowid in memory_vec) so the post-search join mirrors sqlite-vec
// exactly. See memory/turbovec-deferred.md for the scale-based deferral rationale.

import type { TurbovecStatus } from "../../../shared/learning.js";
import { surfaceError } from "../util/diagnostics.js";

const BASE_URL = process.env.PERCEPTION_WORKER_URL ?? "http://127.0.0.1:8789";
const STATUS_TIMEOUT_MS = 500;
const CALL_TIMEOUT_MS = 30_000;
// A backfill batch can be thousands of 768-dim vectors — give it a generous ceiling.
const BATCH_TIMEOUT_MS = 120_000;

// Cached availability so the hot path (vectorSearch) doesn't pay a 500ms probe on
// every /api/ask when turbovec is enabled. Refreshed lazily with a 30s TTL; a down
// worker is cached as "unavailable" for 30s (bounded cost), not re-probed each ask.
const AVAIL_TTL_MS = 30_000;
let _availCache: { val: boolean; at: number } | null = null;

function downStatus(message: string): TurbovecStatus {
  return {
    state: "unavailable",
    enabled: false,
    dim: null,
    bitWidth: null,
    count: 0,
    message,
    updatedAt: null,
  };
}

function normalizeStatus(raw: Partial<TurbovecStatus> & Record<string, unknown>): TurbovecStatus {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const validStates: TurbovecStatus["state"][] = ["ready", "unavailable", "error"];
  const state = validStates.includes(raw.state as TurbovecStatus["state"])
    ? (raw.state as TurbovecStatus["state"])
    : "unavailable";
  return {
    state,
    enabled: raw.enabled === true,
    dim: num(raw.dim),
    bitWidth: num(raw.bitWidth),
    count: num(raw.count) ?? 0,
    message: str(raw.message),
    updatedAt: str(raw.updatedAt),
  };
}

async function fetchJson<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  source: string,
  quiet = false,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        // not JSON — keep raw text
      }
      if (!quiet) surfaceError(source, new Error(`HTTP ${res.status}: ${detail}`));
      return { ok: false, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    if (!quiet) surfaceError(source, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the worker's turbovec index. Cheap (500ms cap) — safe while a panel is open. */
export async function getTurbovecStatus(): Promise<TurbovecStatus> {
  const r = await fetchJson<Record<string, unknown>>(
    "/vector/status",
    { method: "GET" },
    STATUS_TIMEOUT_MS,
    "learning:turbovec-status",
    true, // a down worker is expected, not a swallowed error
  );
  if (!r.ok) {
    return downStatus(
      "turbovec worker offline. Start the worker (worker/main.py) with turbovec installed (worker/requirements-ml.txt).",
    );
  }
  return normalizeStatus(r.data);
}

/** Async availability for the hot path, TTL-cached so /api/ask doesn't probe every call. */
export async function isTurbovecAvailable(): Promise<boolean> {
  const now = Date.now();
  if (_availCache && now - _availCache.at < AVAIL_TTL_MS) return _availCache.val;
  const status = await getTurbovecStatus();
  const val = status.state === "ready";
  _availCache = { val, at: now };
  return val;
}

/** Sync snapshot of the last cached probe (false before the first probe). Used by
 *  /api/health so it never pays a probe — the real probe lives here + the status route. */
export function cachedTurbovecAvailable(): boolean {
  return _availCache?.val ?? false;
}

/** For selfcheck/tests: reset the availability cache between cases. */
export function _resetTurbovecCacheForTest(): void {
  _availCache = null;
}

export interface TurbovecHit {
  id: number;
  score: number;
}
export interface TurbovecSearchResult {
  ok: boolean;
  hits: TurbovecHit[];
  error: string | null;
}
export interface TurbovecOpResult {
  ok: boolean;
  added: number;
  error: string | null;
}

/**
 * Map a turbovec similarity (higher=closer, ~cosine in [-1,1]) to the brain's
 * sqlite-vec-compatible score shape. The sqlite-vec path scores `1/(1+distance)`
 * where distance is lower=closer; for unit-normalised embeddings L2 distance lives
 * in [0,2] so that score lands in [~0.33, 1]. Using distance = 1 - similarity gives
 * `score = 1/(2 - s)`, the SAME [~0.33, 1] range, so the ranker's learned `vecScore`
 * feature transfers between backends without a full retrain. Pure (no I/O) so the
 * selfcheck covers the transform.
 */
export function scoreFromTurbovecSimilarity(s: number): number {
  const sim = Number.isFinite(s) ? s : 0;
  // Clamp s below 2 so 2-s stays positive (quantisation can nudge similarity past 1).
  return 1 / (2 - Math.min(1.999, sim));
}

export async function turbovecAdd(id: number, vector: number[]): Promise<TurbovecOpResult> {
  const r = await fetchJson<Record<string, unknown>>(
    "/vector/add",
    { method: "POST", body: JSON.stringify({ id, vector }) },
    CALL_TIMEOUT_MS,
    "learning:turbovec-add",
    true, // ingestion mirror is fire-and-forget; a down worker must not spam diagnostics
  );
  if (!r.ok) return { ok: false, added: 0, error: r.error };
  return { ok: r.data.ok === true, added: typeof r.data.added === "number" ? r.data.added : 1, error: null };
}

export async function turbovecAddBatch(
  items: { id: number; vector: number[] }[],
): Promise<TurbovecOpResult> {
  if (items.length === 0) return { ok: true, added: 0, error: null };
  const r = await fetchJson<Record<string, unknown>>(
    "/vector/add_batch",
    { method: "POST", body: JSON.stringify({ items }) },
    BATCH_TIMEOUT_MS,
    "learning:turbovec-addbatch",
  );
  if (!r.ok) return { ok: false, added: 0, error: r.error };
  return {
    ok: r.data.ok === true,
    added: typeof r.data.added === "number" ? r.data.added : items.length,
    error: null,
  };
}

export async function turbovecSearch(
  vector: number[],
  k: number,
  filterIds?: number[],
): Promise<TurbovecSearchResult> {
  const r = await fetchJson<Record<string, unknown>>(
    "/vector/search",
    { method: "POST", body: JSON.stringify({ vector, k, filter_ids: filterIds ?? null }) },
    CALL_TIMEOUT_MS,
    "learning:turbovec-search",
  );
  if (!r.ok) return { ok: false, hits: [], error: r.error };
  const hits = Array.isArray(r.data.hits)
    ? (r.data.hits as Array<Record<string, unknown>>)
        .map((h) => ({
          id: typeof h.id === "number" ? h.id : Number(h.id ?? -1),
          score: typeof h.score === "number" ? h.score : 0,
        }))
        .filter((h) => Number.isFinite(h.id) && h.id >= 0)
    : [];
  return { ok: r.data.ok === true, hits, error: null };
}

export async function turbovecClear(): Promise<TurbovecOpResult> {
  const r = await fetchJson<Record<string, unknown>>(
    "/vector/clear",
    { method: "POST", body: JSON.stringify({}) },
    CALL_TIMEOUT_MS,
    "learning:turbovec-clear",
  );
  if (!r.ok) return { ok: false, added: 0, error: r.error };
  return { ok: r.data.ok === true, added: 0, error: null };
}

// --- Bounded ingestion-mirror queue ------------------------------------------
// upsertMemoryPoint mirrors every new embedding into the worker index. The old
// call site was `void turbovecAdd(...)` per upsert — an UNBOUNDED promise
// fan-out: against a slow/wedged worker, one 30s-timeout promise piled up per
// ingest (a 50k scan = 50k in-flight). This bounds it to a single in-flight add
// behind a capped queue, dropping the oldest pending vector on overflow (the
// next /api/learning/turbovec/backfill reconciles any drop). All async + caught,
// so it never blocks or throws into the (sync) ingest path.
const MIRROR_QUEUE_MAX = 1000;
const mirrorQueue: Array<{ id: number; vector: number[] }> = [];
let mirrorDraining = false;
let mirrorDropped = 0;
// Indirection so the selfcheck can inject a fast adder instead of hitting a real
// (absent) worker — keeps the queue/drop/drain logic hermetically testable.
let mirrorAddImpl: (id: number, vector: number[]) => Promise<TurbovecOpResult> = turbovecAdd;

export function turbovecEnqueueAdd(id: number, vector: number[]): void {
  if (mirrorQueue.length >= MIRROR_QUEUE_MAX) {
    mirrorQueue.shift(); // drop oldest — bounded memory, backfill reconciles
    mirrorDropped += 1;
  }
  mirrorQueue.push({ id, vector });
  void drainMirror();
}

async function drainMirror(): Promise<void> {
  if (mirrorDraining) return;
  mirrorDraining = true;
  try {
    while (mirrorQueue.length > 0) {
      const item = mirrorQueue.shift();
      if (!item) break;
      try {
        await mirrorAddImpl(item.id, item.vector);
      } catch {
        // turbovecAdd already swallows + quietly surfaces; never rethrow into the drain.
      }
    }
  } finally {
    mirrorDraining = false;
  }
}

/** Selfcheck/health hook: current queue depth + lifetime drop count. */
export function turbovecMirrorStats(): { queued: number; dropped: number } {
  return { queued: mirrorQueue.length, dropped: mirrorDropped };
}

/** Selfcheck hook: swap the per-item adder (e.g. a fast no-op) for hermetic tests. */
export function _setTurbovecAddImplForTest(
  fn: (id: number, vector: number[]) => Promise<TurbovecOpResult>,
): void {
  mirrorAddImpl = fn;
}

/** Selfcheck hook: clear the queue + counters and restore the real adder. */
export function _resetTurbovecMirrorForTest(): void {
  mirrorQueue.length = 0;
  mirrorDropped = 0;
  mirrorAddImpl = turbovecAdd;
}

/** Selfcheck helper. */
export const TURBOVEC_BASE_URL = BASE_URL;