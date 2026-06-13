// Adaptive depth threshold selfcheck — hermetic (throwaway DB).
//
// Run: npx tsx server/scripts/adaptivedepth-selfcheck.ts
//      (or: npm --prefix server run adaptivedepth:selfcheck)

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Set env BEFORE any module imports so openDb() picks the throwaway path.
const tmp = mkdtempSync(join(tmpdir(), "brain-adaptivedepth-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  DEFAULT_WARM_AT,
  MAX_NUDGE,
  emptyAdaptiveDepthState,
  adjustThreshold,
  observeDepthOutcome,
  loadAdaptiveDepthState,
  saveAdaptiveDepthState,
} = await import("../src/reasoning/adaptiveDepth.js");

const { openDb } = await import("../src/db/sqlite.js");

// ---------------------------------------------------------------------------
// 1. COLD: no-regression floor — returns base EXACTLY.
// ---------------------------------------------------------------------------

{
  const state = emptyAdaptiveDepthState();
  const result = adjustThreshold(0.65, state);
  check(
    "cold: adjustThreshold returns base EXACTLY",
    result === 0.65,
    `got ${result}`,
  );
}

// ---------------------------------------------------------------------------
// 2. WARM, mostly "shallow poorly cited" → threshold LOWERS (more full).
// ---------------------------------------------------------------------------

{
  let state = emptyAdaptiveDepthState();
  // Force >= DEFAULT_WARM_AT observations, all shallow + citedCount 0.
  for (let i = 0; i < DEFAULT_WARM_AT + 10; i++) {
    state = observeDepthOutcome(state, { depth: "shallow", citedCount: 0 });
  }
  check(
    "warm with shallow-poorly-cited: observations >= warmAt",
    state.observations >= DEFAULT_WARM_AT,
    `observations=${state.observations}`,
  );
  const adjusted = adjustThreshold(0.65, state);
  check(
    "warm shallow-poorly-cited: threshold lowers (more full)",
    adjusted < 0.65,
    `adjusted=${adjusted.toFixed(6)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. WARM, mostly "full no gain" → threshold RAISES (more shallow).
// ---------------------------------------------------------------------------

{
  let state = emptyAdaptiveDepthState();
  // Force >= DEFAULT_WARM_AT observations, all full + citedCount 0.
  for (let i = 0; i < DEFAULT_WARM_AT + 10; i++) {
    state = observeDepthOutcome(state, { depth: "full", citedCount: 0 });
  }
  const adjusted = adjustThreshold(0.65, state);
  check(
    "warm full-no-gain: threshold raises (more shallow)",
    adjusted > 0.65,
    `adjusted=${adjusted.toFixed(6)}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Nudge is always within ±MAX_NUDGE and clamped to [0, 1].
// ---------------------------------------------------------------------------

{
  // Build a saturated "lower pressure" state.
  let stateLow = emptyAdaptiveDepthState();
  for (let i = 0; i < 100; i++) {
    stateLow = observeDepthOutcome(stateLow, { depth: "shallow", citedCount: 0 });
  }

  // Build a saturated "raise pressure" state.
  let stateHigh = emptyAdaptiveDepthState();
  for (let i = 0; i < 100; i++) {
    stateHigh = observeDepthOutcome(stateHigh, { depth: "full", citedCount: 0 });
  }

  // Test base near 0 (clamping floor).
  const nearZeroLow = adjustThreshold(0.02, stateLow);
  check(
    "clamped to [0,1]: near-zero base with lower pressure >= 0",
    nearZeroLow >= 0,
    `got ${nearZeroLow}`,
  );
  check(
    "within ±MAX_NUDGE: near-zero base with lower pressure",
    nearZeroLow >= 0.02 - MAX_NUDGE - 1e-9,
    `got ${nearZeroLow}, floor=${0.02 - MAX_NUDGE}`,
  );

  // Test base near 1 (clamping ceiling).
  const nearOneHigh = adjustThreshold(0.98, stateHigh);
  check(
    "clamped to [0,1]: near-one base with raise pressure <= 1",
    nearOneHigh <= 1,
    `got ${nearOneHigh}`,
  );
  check(
    "within ±MAX_NUDGE: near-one base with raise pressure",
    nearOneHigh <= 0.98 + MAX_NUDGE + 1e-9,
    `got ${nearOneHigh}, ceiling=${0.98 + MAX_NUDGE}`,
  );

  // The unclamped nudge itself must be within ±MAX_NUDGE of base.
  const midLow = adjustThreshold(0.5, stateLow);
  const midHigh = adjustThreshold(0.5, stateHigh);
  check(
    "nudge magnitude within MAX_NUDGE (lower pressure)",
    Math.abs(midLow - 0.5) <= MAX_NUDGE + 1e-9,
    `delta=${Math.abs(midLow - 0.5).toFixed(6)}`,
  );
  check(
    "nudge magnitude within MAX_NUDGE (raise pressure)",
    Math.abs(midHigh - 0.5) <= MAX_NUDGE + 1e-9,
    `delta=${Math.abs(midHigh - 0.5).toFixed(6)}`,
  );
}

// ---------------------------------------------------------------------------
// 5. KV round-trip: save then load returns identical state.
// ---------------------------------------------------------------------------

{
  let state = emptyAdaptiveDepthState();
  for (let i = 0; i < 30; i++) {
    state = observeDepthOutcome(state, {
      depth: i % 3 === 0 ? "full" : "shallow",
      citedCount: i % 2,
    });
  }

  saveAdaptiveDepthState(state);
  const reloaded = loadAdaptiveDepthState();

  check(
    "round-trip: observations match",
    reloaded.observations === state.observations,
    `saved=${state.observations} loaded=${reloaded.observations}`,
  );
  check(
    "round-trip: shallowWellCited matches",
    reloaded.shallowWellCited === state.shallowWellCited,
  );
  check(
    "round-trip: shallowPoorlyCited matches",
    reloaded.shallowPoorlyCited === state.shallowPoorlyCited,
  );
  check(
    "round-trip: fullAddedCitations matches",
    reloaded.fullAddedCitations === state.fullAddedCitations,
  );
  check(
    "round-trip: fullNoGain matches",
    reloaded.fullNoGain === state.fullNoGain,
  );
}

// ---------------------------------------------------------------------------
// 6. Broken store: loadAdaptiveDepthState returns empty; save does NOT throw.
// ---------------------------------------------------------------------------

{
  // Drop the backing table.
  openDb().exec("DROP TABLE IF EXISTS brain_metadata");

  let threw = false;
  let loaded: ReturnType<typeof emptyAdaptiveDepthState> | null = null;
  try {
    loaded = loadAdaptiveDepthState();
    saveAdaptiveDepthState(emptyAdaptiveDepthState());
  } catch {
    threw = true;
  }

  check("broken store: no throw from load or save", threw === false);
  check(
    "broken store: load returns empty default",
    loaded !== null && loaded.observations === 0,
    `observations=${loaded?.observations}`,
  );
  check(
    "broken store: empty state adjustThreshold still returns base exactly",
    loaded !== null && adjustThreshold(0.65, loaded) === 0.65,
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
