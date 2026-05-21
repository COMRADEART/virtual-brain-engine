// Pure CPU-utilisation math, isolated with ZERO imports so the offline
// twin-selfcheck can import it without dragging in better-sqlite3 (collectors.ts
// imports openDb). Mirrors the ranker:selfcheck / agents:selfcheck discipline.

/** Per-core CPU time accumulators (cumulative since boot). */
export interface CpuSample {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/**
 * CPU utilisation 0-100. Pure & deterministic.
 *
 * With a previous sample we diff the time accumulators (true instantaneous
 * load). On the first capture (`prev === null`) we fall back to the cumulative
 * since-boot ratio — a long-run average, never presented as instantaneous.
 */
export function computeCpuPct(
  prev: CpuSample[] | null,
  curr: CpuSample[],
): number {
  if (curr.length === 0) return 0;
  let busyDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < curr.length; i++) {
    const c = curr[i];
    const cTotal = c.user + c.nice + c.sys + c.idle + c.irq;
    if (prev && prev[i]) {
      const p = prev[i];
      const pTotal = p.user + p.nice + p.sys + p.idle + p.irq;
      const dTotal = cTotal - pTotal;
      const dIdle = c.idle - p.idle;
      if (dTotal > 0) {
        totalDelta += dTotal;
        busyDelta += dTotal - dIdle;
      }
    } else {
      totalDelta += cTotal;
      busyDelta += cTotal - c.idle;
    }
  }
  if (totalDelta <= 0) return 0;
  const pct = (busyDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}
