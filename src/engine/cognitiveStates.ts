// Cognitive-state profiles for SpikingEngine.
//
// A `CognitiveState` is a *modulation* overlay applied on top of an anatomical
// `BrainAction`. The action picks which regions get external drive (i.e. the
// "what" — what circuits are recruited). The state picks the neuromodulator,
// oscillation, and extra-drive context (i.e. the "how" — focused vs.
// daydreaming vs. recalling).
//
// Pass one into `spikingEngine.applyCognitiveState(state)` whenever the user
// (or the orchestrator) wants to colour the simulation with a particular
// cognitive mode. The settings stick until overridden — neuromodulators decay
// back toward their baselines on their own.
//
// The three presets below are deliberately illustrative — they map onto
// well-known network-level findings (theta-driven hippocampal-PFC coupling
// for recall, gamma-locked PFC for focus, lower-ACh default-mode-network
// activity for spontaneous "creative" associations).

import type { BrainRegionId } from "./types";

export interface CognitiveState {
  /** Display name (used in UI). */
  name: string;
  /** One-line summary, for tooltips. */
  description: string;
  /**
   * Tonic dopamine level [0,1]. Baseline ~0.3. Phasic boosts (rewards, action
   * switches) happen automatically inside the engine; this is the steady state.
   */
  dopamine?: number;
  /**
   * Tonic acetylcholine level [0,1]. Baseline ~0.4. Higher ACh → sharper
   * stimulus-driven responses + less spontaneous noise (attention regime).
   * Lower ACh → noisier, more associative state (default-mode / creativity).
   */
  acetylcholine?: number;
  /** Tonic serotonin level [0,1]. Baseline ~0.2. Mood / regulation tone. */
  serotonin?: number;
  /** Tonic norepinephrine level [0,1]. Baseline ~0.1. Arousal / alertness. */
  norepinephrine?: number;
  /** Multiplier on theta-band drive (default 1.0). 4-8 Hz, hippocampus + PFC. */
  thetaGain?: number;
  /** Multiplier on gamma-band drive (default 1.0). 30-80 Hz, perceptual binding. */
  gammaGain?: number;
  /**
   * Additional per-region drive on top of whatever the BrainAction set.
   * Useful when a cognitive mode wants to recruit DMN nodes (e.g. medial PFC,
   * temporal) that the current action wouldn't activate by itself.
   * Values are clamped against the existing drive — only the larger wins.
   */
  extraDrive?: Array<[BrainRegionId, number]>;
}

/**
 * Focused attention: PFC + parietal locked into the gamma band, mid-high ACh,
 * dopamine slightly elevated. Models a task-positive, attention-on regime —
 * the brain when you're actively solving a problem.
 */
export const FOCUS_STATE: CognitiveState = {
  name: "Focus",
  description: "Task-positive attention: gamma-locked PFC, high ACh, sharpened responses.",
  dopamine: 0.42,
  acetylcholine: 0.78,
  thetaGain: 0.6,
  gammaGain: 1.6,
  extraDrive: [
    ["prefrontal-l", 0.8],
    ["prefrontal-r", 0.8],
    ["parietal-l", 0.7],
    ["parietal-r", 0.7],
    ["frontal-l", 0.5],
    ["frontal-r", 0.5],
  ],
};

/**
 * Memory recall: hippocampus + PFC riding strong theta, high ACh (the
 * encoding/retrieval consolidation regime), moderate dopamine. Mirrors the
 * "θ-coupled replay" pattern reported during episodic retrieval.
 */
export const RECALL_MEMORY_STATE: CognitiveState = {
  name: "Recall Memory",
  description: "Theta-driven hippocampal-PFC coupling for episodic retrieval.",
  dopamine: 0.4,
  acetylcholine: 0.7,
  thetaGain: 2.2,
  gammaGain: 1.0,
  extraDrive: [
    ["hippocampus-l", 1.0],
    ["hippocampus-r", 1.0],
    ["prefrontal-l", 0.6],
    ["prefrontal-r", 0.6],
    ["temporal-l", 0.7],
    ["temporal-r", 0.7],
  ],
};

/**
 * Creative thinking: lower ACh (noisy, defocused), moderate-high dopamine
 * (novelty-seeking), broad slow-rhythm activity. Recruits default-mode nodes
 * (medial PFC + lateral temporal) and lets the network roam — this is the
 * regime associated with spontaneous remote associations.
 */
export const CREATIVE_THINKING_STATE: CognitiveState = {
  name: "Creative Thinking",
  description: "Default-mode association: low ACh, elevated dopamine, broad theta.",
  dopamine: 0.55,
  acetylcholine: 0.25,
  thetaGain: 1.6,
  gammaGain: 0.7,
  extraDrive: [
    ["prefrontal-l", 0.6],
    ["prefrontal-r", 0.6],
    ["temporal-l", 0.8],
    ["temporal-r", 0.8],
    ["parietal-r", 0.5],
    ["hippocampus-l", 0.4],
    ["hippocampus-r", 0.4],
  ],
};

export const COGNITIVE_STATES = {
  focus: FOCUS_STATE,
  recall: RECALL_MEMORY_STATE,
  creative: CREATIVE_THINKING_STATE,
} as const;

export type CognitiveStateId = keyof typeof COGNITIVE_STATES;
