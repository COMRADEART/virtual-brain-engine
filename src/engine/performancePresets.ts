import { getEstimatedNeuronCount } from "./neuralGraphGenerator";

export type PerfPresetId = "light" | "balanced" | "cinematic";

export interface PerfPreset {
  id: PerfPresetId;
  label: string;
  /** Fed straight into generateNeuralGraph({ density }). The live neuron count
   *  is computed from the real generator via presetNeuronCount() — tune these
   *  three numbers against the StatusBar readout to hit your targets. */
  density: number;
  /** renderer.setPixelRatio cap. 1.75 was the old hard-coded value. */
  dprCap: number;
  /** UnrealBloomPass is the single most expensive pass — off below Cinematic. */
  bloom: boolean;
  /** Caps the active pulse pool (per-preset replacement for MAX_PULSES=260). */
  maxPulses: number;
}

// Density anchors reuse the project's already-calibrated values
// (RegionControls.NEURON_PRESETS used 0.4 / 1.0 / 2.5). The default moves from
// the old 1.0 down to 0.7 so the app launches lighter out of the box.
export const PERF_PRESETS: Record<PerfPresetId, PerfPreset> = {
  light: {
    id: "light",
    label: "Light",
    density: 0.4,
    dprCap: 1.0,
    bloom: false,
    maxPulses: 90,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    density: 0.7,
    dprCap: 1.25,
    bloom: false,
    maxPulses: 160,
  },
  cinematic: {
    id: "cinematic",
    label: "Cinematic",
    density: 1.5,
    dprCap: 1.75,
    bloom: true,
    maxPulses: 320,
  },
};

export const PERF_PRESET_IDS: PerfPresetId[] = ["light", "balanced", "cinematic"];

export const DEFAULT_PRESET: PerfPresetId = "balanced";

// A user-selectable mode is a fixed preset OR "auto" (adaptive controller
// picks the tier to hold a target framerate — see adaptiveQuality.ts).
export type PerfMode = PerfPresetId | "auto";

export const PERF_MODE_IDS: PerfMode[] = ["light", "balanced", "cinematic", "auto"];

export const MODE_LABELS: Record<PerfMode, string> = {
  light: "Light",
  balanced: "Balanced",
  cinematic: "Cinematic",
  auto: "Auto",
};

// Tier the adaptive controller starts from before it has measured anything.
export const DEFAULT_AUTO_TIER: PerfPresetId = "balanced";

/** Next mode in light → balanced → cinematic → auto → light order. */
export function nextMode(mode: PerfMode): PerfMode {
  const index = PERF_MODE_IDS.indexOf(mode);
  return PERF_MODE_IDS[(index + 1) % PERF_MODE_IDS.length];
}

/** Real neuron count for a preset (sums region.baseNeuronCount * density). */
export function presetNeuronCount(id: PerfPresetId): number {
  return getEstimatedNeuronCount(PERF_PRESETS[id].density);
}

/** Next preset in light → balanced → cinematic → light order. */
export function nextPreset(id: PerfPresetId): PerfPresetId {
  const index = PERF_PRESET_IDS.indexOf(id);
  return PERF_PRESET_IDS[(index + 1) % PERF_PRESET_IDS.length];
}
