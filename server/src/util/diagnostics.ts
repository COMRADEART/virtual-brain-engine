// Surfacing for previously-swallowed errors. Several memory-layer writes are
// deliberately wrapped in `try { ... } catch {}` because a strength/importance
// write must never break the caller's pipeline — but a silent catch is exactly
// what let a real SQL-identifier bug hide (see memoryStrength.ts). This util
// keeps the "don't throw" guarantee while making the failure observable:
//   1. always log (never silent again),
//   2. count per call-site (exposed on /api/health),
//   3. broadcast on the brain bus, throttled so a recurring failure can't flood it.

import { broadcast } from "../ws/brainBus.js";
import { incr } from "../observability/metrics.js";
import { persistDiagnostic } from "../observability/vitals.js";

const counts = new Map<string, number>();
const lastBroadcast = new Map<string, number>();
const BROADCAST_THROTTLE_MS = 10_000;

export function surfaceError(
  source: string,
  err: unknown,
  level: "warn" | "error" = "warn",
): void {
  const message = err instanceof Error ? err.message : String(err);
  const count = (counts.get(source) ?? 0) + 1;
  counts.set(source, count);
  // (2) Feed the metrics registry so the error rate surfaces in vitals.
  incr("errors.total");
  incr(`errors.${source}`);

  // (1) Always log — this is the "stops being silent" guarantee.
  if (level === "error") {
    console.error(`[diag] ${source}: ${message}`);
  } else {
    console.warn(`[diag] ${source}: ${message}`);
  }

  // (3) Throttle the bus broadcast per source so a persistent failure (e.g. a
  // broken column) can't emit at pipeline frequency.
  const now = Date.now();
  if (now - (lastBroadcast.get(source) ?? 0) >= BROADCAST_THROTTLE_MS) {
    lastBroadcast.set(source, now);
    // (4) Persist into the durable taxonomy. The throttle gate bounds DB writes
    // to one row per source per window. Best-effort — persistDiagnostic never
    // throws (it must not: it's called from the universal error sink).
    persistDiagnostic(source, level, message, count);
    try {
      broadcast({
        type: "diagnostic",
        source,
        level,
        message,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Bus not attached (e.g. a selfcheck/CLI context) — logging + counting
      // already happened, so the error is still surfaced.
    }
  }
}

// Per-source error counts since boot. Surfaced on /api/health so a silent
// degradation shows up as a non-zero counter instead of vanishing.
export function getDiagnosticCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

// Test/selfcheck helper.
export function resetDiagnostics(): void {
  counts.clear();
  lastBroadcast.clear();
}
