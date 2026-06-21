// Memory DNA — the living per-memory attributes (emotion / trust / source-
// verification) the master vision asks for on top of what memory_points already
// carries (importance, decay, usage via the access log, connections via
// memory_relations).
//
// Decision: these live in `metadata.dna` (a structured JSON key), NOT new
// columns. memory_points.metadata already exists and is already written with
// structured keys ({conversationId, runId}, {kind, bidKind}); these three fields
// are read per-already-fetched MemoryPoint and never queried/filtered in SQL, so
// they don't need indexed columns — and adding 3 columns to the hottest table
// for non-queried scalars would be unjustified churn. No migration.
//
// Discipline (the saliency.ts / neuromodulators.ts contract):
//   - PURE + exported: deriveDna / readDna / mergeDna / trustDemotion take plain
//     inputs so the selfcheck drives them with no DB.
//   - readDna is LEGACY-SAFE: a memory written before this feature has no
//     `metadata.dna`, so readDna falls back to inferring trust/verification from
//     the row's provenance (sourceType + metadata.source). It never throws.
//   - The behavioral consumer (a retrieval demotion) is a STRICT no-op unless a
//     memory's trust is genuinely low — trustDemotion returns exactly 1.0 for
//     unknown/normal trust — and is itself behind CONFIG.memoryDna (default OFF).

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import type { MemoryDna, MemoryVerification, MemorySourceType } from "../../../shared/memory.js";

export const VERIFICATIONS: ReadonlyArray<MemoryVerification> = [
  "unverified",
  "web-corroborated",
  "user-confirmed",
  "self-derived",
];

// Retrieval-demotion knobs (exported so the selfcheck pins them).
export const TRUST_OK = 0.5; // trust ≥ this → no demotion (factor 1.0)
export const TRUST_DEMOTION_FLOOR = 0.85; // worst-case multiplier at trust 0

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE — the selfcheck drives these directly (no DB).
// -----------------------------------------------------------------------------

export interface DnaDeriveInput {
  /** The ingest source label, e.g. "conversation" | "ingest:web" | "ingest:github" | "file". */
  source: string;
  /** Calibrated confidence of the producing cycle (conversation answers). */
  confidence?: number;
  /** How many memories the producing answer cited. */
  citedCount?: number;
  /** Explicit affective valence at write time (e.g. the dominant-emotion value). */
  emotion?: number;
}

/** Trust + verification for a known provenance label. Pure. */
function provenanceTrust(source: string, sourceType?: MemorySourceType): { trust: number; verification: MemoryVerification } {
  const s = source.toLowerCase();
  if (s.includes("ingest:web") || s === "web") return { trust: 0.35, verification: "web-corroborated" };
  if (s.includes("ingest:github") || s === "github") return { trust: 0.5, verification: "web-corroborated" };
  if (s === "file" || sourceType === "chunk") return { trust: 0.7, verification: "user-confirmed" };
  if (sourceType === "manual" || s === "manual") return { trust: 0.6, verification: "self-derived" };
  if (sourceType === "conversation" || s === "conversation") return { trust: 0.55, verification: "self-derived" };
  return { trust: 0.5, verification: "unverified" };
}

/** Derive DNA for a memory being written. Pure. */
export function deriveDna(input: DnaDeriveInput): MemoryDna {
  const base = provenanceTrust(input.source);
  let trust = base.trust;
  let verification = base.verification;
  // A grounded, confident conversation answer is more trustworthy than a guess.
  if ((input.source === "conversation" || verification === "self-derived") && typeof input.confidence === "number") {
    const grounded = (input.citedCount ?? 0) > 0 && clamp01(input.confidence) >= 0.5;
    if (grounded) {
      trust = Math.max(trust, 0.65);
      verification = "user-confirmed";
    }
  }
  return {
    emotion: clamp01(input.emotion ?? 0.5),
    trust: clamp01(trust),
    verification,
  };
}

/** Merge DNA into a metadata object under the `dna` key. Pure (returns a new object). */
export function mergeDna(
  metadata: Record<string, unknown> | undefined,
  dna: MemoryDna,
): Record<string, unknown> {
  return { ...(metadata ?? {}), dna };
}

interface DnaReadable {
  metadata?: Record<string, unknown> | null;
  sourceType?: MemorySourceType;
}

/**
 * Read a memory's DNA. Explicit `metadata.dna` wins; otherwise infer from the
 * row's provenance (sourceType + metadata.source) so memories written before
 * this feature still carry a sensible trust/verification. Never throws.
 */
export function readDna(memory: DnaReadable | null | undefined): MemoryDna {
  const meta = memory?.metadata ?? undefined;
  const raw = meta && typeof meta === "object" ? (meta as Record<string, unknown>).dna : undefined;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const out: MemoryDna = {};
    if (typeof r.emotion === "number") out.emotion = clamp01(r.emotion);
    if (typeof r.trust === "number") out.trust = clamp01(r.trust);
    if (typeof r.verification === "string" && (VERIFICATIONS as readonly string[]).includes(r.verification)) {
      out.verification = r.verification as MemoryVerification;
    }
    if (out.emotion !== undefined || out.trust !== undefined || out.verification !== undefined) return out;
  }
  // Legacy / no-DNA fallback: infer from provenance.
  const source = typeof (meta as Record<string, unknown> | undefined)?.source === "string"
    ? String((meta as Record<string, unknown>).source)
    : "";
  const inferred = provenanceTrust(source, memory?.sourceType);
  return { trust: inferred.trust, verification: inferred.verification };
}

/**
 * Multiplicative retrieval demotion for a memory's score. EXACTLY 1.0 for
 * unknown/normal trust (≥ TRUST_OK), ramping down to TRUST_DEMOTION_FLOOR at
 * trust 0 — a gentle nudge away from low-credibility (raw web) memories. Pure.
 */
export function trustDemotion(dna: MemoryDna | null | undefined): number {
  const t = dna?.trust;
  if (typeof t !== "number" || !Number.isFinite(t) || t >= TRUST_OK) return 1.0;
  const frac = clamp01(t / TRUST_OK); // 0 at trust 0, 1 at TRUST_OK
  return TRUST_DEMOTION_FLOOR + (1 - TRUST_DEMOTION_FLOOR) * frac;
}

// -----------------------------------------------------------------------------
// Stats surface (route) — tally DNA over a recent sample. Failure-isolated.
// -----------------------------------------------------------------------------

export interface MemoryDnaStats {
  sampled: number;
  byVerification: Record<MemoryVerification, number>;
  avgTrust: number;
  avgEmotion: number;
  lowTrust: number; // count below TRUST_OK (the ones the demotion touches)
}

export function memoryDnaStats(limit = 500): MemoryDnaStats {
  const byVerification: Record<MemoryVerification, number> = {
    unverified: 0,
    "web-corroborated": 0,
    "user-confirmed": 0,
    "self-derived": 0,
  };
  let sampled = 0;
  let trustSum = 0;
  let emotionSum = 0;
  let emotionN = 0;
  let lowTrust = 0;
  try {
    const rows = openDb()
      .prepare(
        `SELECT source_type, metadata FROM memory_points ORDER BY created_at DESC LIMIT ?`,
      )
      .all(Math.min(5000, Math.max(1, limit))) as Array<{ source_type: MemorySourceType; metadata: string | null }>;
    for (const row of rows) {
      let metadata: Record<string, unknown> | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          metadata = undefined;
        }
      }
      const dna = readDna({ metadata, sourceType: row.source_type });
      sampled += 1;
      const v = dna.verification ?? "unverified";
      byVerification[v] += 1;
      if (typeof dna.trust === "number") {
        trustSum += dna.trust;
        if (dna.trust < TRUST_OK) lowTrust += 1;
      }
      if (typeof dna.emotion === "number") {
        emotionSum += dna.emotion;
        emotionN += 1;
      }
    }
  } catch (err) {
    surfaceError("memoryDna.stats", err);
  }
  return {
    sampled,
    byVerification,
    avgTrust: sampled > 0 ? trustSum / sampled : 0,
    avgEmotion: emotionN > 0 ? emotionSum / emotionN : 0,
    lowTrust,
  };
}
