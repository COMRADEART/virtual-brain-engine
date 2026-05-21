// Adaptive quality controller. This is a hysteresis control loop (the same
// technique real engines use for dynamic resolution scaling), NOT RL — a
// learned policy here would add non-determinism and overhead for no gain.
//
// It walks the fixed PERF_PRESET_IDS ladder up/down by at most one tier at a
// time, and only after a dwell window of sustained over/under-shoot, so it
// settles instead of oscillating. Pure + side-effect-free so it can be
// reasoned about and (later) unit-checked in isolation.

import { PERF_PRESET_IDS, type PerfPresetId } from "./performancePresets";

export interface AutoQualityState {
  tierIndex: number; // index into PERF_PRESET_IDS
  emaFps: number; // smoothed framerate
  belowMs: number; // accumulated time under DOWN_FPS
  aboveMs: number; // accumulated time over UP_FPS
}

// Targeting 60 fps: drop quality if we sustain < 45, raise if we sustain > 58.
// The gap between thresholds is the hysteresis band.
const DOWN_FPS = 45;
const UP_FPS = 58;
// React to jank quickly; upscale cautiously (avoids a sawtooth on borderline
// hardware where a higher tier immediately drops us back down).
const DWELL_DOWN_MS = 2500;
const DWELL_UP_MS = 7000;
const EMA_ALPHA = 0.3;

export function createAutoState(startTier: PerfPresetId): AutoQualityState {
  return {
    tierIndex: Math.max(0, PERF_PRESET_IDS.indexOf(startTier)),
    emaFps: 60,
    belowMs: 0,
    aboveMs: 0,
  };
}

export function tierIdAt(index: number): PerfPresetId {
  const clamped = Math.min(PERF_PRESET_IDS.length - 1, Math.max(0, index));
  return PERF_PRESET_IDS[clamped];
}

// Pure step. tierIndex changes by at most 1, and only once the relevant dwell
// window is satisfied. A non-finite/zero fps sample carries the EMA forward
// unchanged (a stalled tab shouldn't be read as "0 fps → slam to Light").
export function stepAutoQuality(
  state: AutoQualityState,
  fpsSample: number,
  dtMs: number,
): AutoQualityState {
  const emaFps =
    Number.isFinite(fpsSample) && fpsSample > 0
      ? state.emaFps * (1 - EMA_ALPHA) + fpsSample * EMA_ALPHA
      : state.emaFps;

  const minTier = 0;
  const maxTier = PERF_PRESET_IDS.length - 1;
  let belowMs = 0;
  let aboveMs = 0;

  if (emaFps < DOWN_FPS && state.tierIndex > minTier) {
    belowMs = state.belowMs + dtMs;
  } else if (emaFps > UP_FPS && state.tierIndex < maxTier) {
    aboveMs = state.aboveMs + dtMs;
  }

  let tierIndex = state.tierIndex;
  if (belowMs >= DWELL_DOWN_MS) {
    tierIndex -= 1;
    belowMs = 0;
  } else if (aboveMs >= DWELL_UP_MS) {
    tierIndex += 1;
    aboveMs = 0;
  }

  return { tierIndex, emaFps, belowMs, aboveMs };
}
