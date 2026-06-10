// Biological-plausibility coverage for AdvancedBrainCore (alias: SpikingEngine).
//
// Ported 2026-05-27 from the original aspirational suite that asserted methods
// the engine never implemented (`getFiringRates`, `setGlobalAcetylcholine`,
// `measureThetaGammaCoupling`, …) and region IDs that aren't in the real
// `BrainRegionId` union ('prefrontal-cortex', 'visual', 'pons'). The whole
// suite had been `describe.skip`'d to keep the gate green. The TODO in the
// header asked for a port to the real surface — this is that port.
//
// What we keep: the original test buckets (Biological Plausibility / Cognitive
// Dynamics / Neuromodulation / Performance / Visualization / Emergent Behaviors)
// and the test count (~17 — one test per real-API behaviour worth gating).
// What we drop: every claim that depended on an unimplemented method or on a
// specific firing-rate magnitude. Magnitudes belong in `scripts/diag-probe.mjs`,
// not in unit tests — they're sensitive to E:I gain retunes and would re-break
// every time the dynamics get touched.

import { describe, it, expect, beforeEach } from "vitest";
import { generateNeuralGraph } from "../src/engine/neuralGraphGenerator";
import { SpikingEngine, type ReplayEvent } from "../src/engine/SpikingEngine";
import { isSpikingCapable } from "../src/engine/types";
import {
  FOCUS_STATE,
  RECALL_MEMORY_STATE,
  CREATIVE_THINKING_STATE,
} from "../src/engine/cognitiveStates";
import type { NeuralGraph } from "../src/engine/types";

const FIXED_DELTA = 1 / 60;

function buildGraph(): NeuralGraph {
  // 0.2 density seeds ~1400 neurons in the standard rich-club connectome,
  // matching the 1500-neuron target the original suite used.
  return generateNeuralGraph({ density: 0.2, seed: 19 });
}

function stepFor(engine: SpikingEngine, steps: number): void {
  let elapsed = 0;
  for (let i = 0; i < steps; i += 1) {
    elapsed += FIXED_DELTA;
    engine.step(FIXED_DELTA, elapsed);
  }
}

describe("AdvancedBrainCore neuroscience validation", () => {
  let engine: SpikingEngine;
  let graph: NeuralGraph;

  beforeEach(() => {
    graph = buildGraph();
    engine = new SpikingEngine(graph, "see-object");
  });

  describe("Biological Plausibility", () => {
    it("maintains a ~80/20 excitatory/inhibitory ratio via neuronType", () => {
      let exc = 0;
      let inh = 0;
      for (let i = 0; i < engine.neuronType.length; i += 1) {
        if (engine.neuronType[i] > 0) exc += 1;
        else if (engine.neuronType[i] < 0) inh += 1;
      }
      const total = exc + inh;
      expect(total).toBeGreaterThan(0);
      const excRatio = exc / total;
      expect(excRatio).toBeGreaterThan(0.7);
      expect(excRatio).toBeLessThan(0.9);
    });

    it("keeps mean firing rate finite and physiologically bounded after burn-in", () => {
      stepFor(engine, 120);
      const meanRate = engine.getMeanRate();
      expect(Number.isFinite(meanRate)).toBe(true);
      // Homeostat target ≈ 0.02 (2%) per step; allow a generous envelope so
      // E:I retunes don't break the gate.
      expect(meanRate).toBeGreaterThanOrEqual(0);
      expect(meanRate).toBeLessThan(0.6);
    });

    it("advances theta and gamma oscillator phases over time", () => {
      const theta0 = engine.thetaPhase;
      const gamma0 = engine.gammaPhase;
      // Avoid an integer number of full rotations: theta=6 Hz × gamma=45 Hz
      // would both wrap exactly to 0 after a whole-second multiple at the
      // 1/60 s step. 31 steps × 1/60 s ≈ 0.517 s — guaranteed non-period.
      stepFor(engine, 31);
      const theta1 = engine.thetaPhase;
      const gamma1 = engine.gammaPhase;
      expect(Number.isFinite(theta1) && Number.isFinite(gamma1)).toBe(true);
      // Wrapped to [0, 2π) — both phases should be in range and at least one
      // must visibly move.
      expect(theta1).toBeGreaterThanOrEqual(0);
      expect(theta1).toBeLessThan(2 * Math.PI);
      expect(gamma1).toBeGreaterThanOrEqual(0);
      expect(gamma1).toBeLessThan(2 * Math.PI);
      expect(theta1 !== theta0 || gamma1 !== gamma0).toBe(true);
    });

    it("keeps criticality + branching-ratio finite and non-negative", () => {
      stepFor(engine, 180);
      const crit = engine.getCriticalityScore();
      const branch = engine.getBranchingRatio();
      expect(Number.isFinite(crit)).toBe(true);
      expect(crit).toBeGreaterThanOrEqual(0);
      expect(crit).toBeLessThanOrEqual(1);
      expect(Number.isFinite(branch)).toBe(true);
      expect(branch).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Cognitive Dynamics", () => {
    it("acetylcholine setpoint propagates through setAcetylcholine()", () => {
      const baseline = engine.acetylcholine;
      engine.setAcetylcholine(0.9);
      // setLevel writes immediately; one step lets any rounding/clamping settle.
      stepFor(engine, 1);
      const elevated = engine.acetylcholine;
      expect(elevated).toBeGreaterThan(baseline);
    });

    it("dopamine setpoint propagates through setDopamine()", () => {
      engine.setDopamine(0.05);
      stepFor(engine, 1);
      const low = engine.dopamine;
      engine.setDopamine(0.9);
      stepFor(engine, 1);
      const high = engine.dopamine;
      expect(high).toBeGreaterThan(low);
    });

    it("memory trace getter survives a triggerMemoryReplay() invocation", () => {
      stepFor(engine, 30);
      // Must not throw and must return either null or a correctly sized array.
      expect(() => engine.triggerMemoryReplay()).not.toThrow();
      stepFor(engine, 5);
      const trace = engine.getMemoryTrace();
      if (trace !== null) {
        expect(trace).toBeInstanceOf(Float32Array);
        expect(trace.length).toBe(graph.nodes.length);
        for (let i = 0; i < trace.length; i += 1) {
          expect(Number.isFinite(trace[i])).toBe(true);
        }
      }
    });
  });

  describe("Neuromodulation System", () => {
    it("exposes all four neuromodulators as finite non-negative scalars", () => {
      stepFor(engine, 5);
      for (const level of [
        engine.dopamine,
        engine.acetylcholine,
        engine.serotonin,
        engine.norepinephrine,
      ]) {
        expect(Number.isFinite(level)).toBe(true);
        expect(level).toBeGreaterThanOrEqual(0);
      }
    });

    it("sensory injection drives a visible ACh pulse without unbounded growth", () => {
      engine.setAcetylcholine(0.2);
      stepFor(engine, 1);
      const beforePulse = engine.acetylcholine;
      // injectSensoryText pulses ACh by +0.1 (see AdvancedBrainCore.injectSensoryText).
      engine.injectSensoryText("an unfamiliar pattern arrives in the input stream", true);
      stepFor(engine, 1);
      const pulsed = engine.acetylcholine;
      // The pulse must visibly raise the level above the pre-pulse value.
      expect(pulsed).toBeGreaterThan(beforePulse);
      // After many further steps the system stays bounded (no runaway).
      // ACh tracks a baseline that may exceed the seeded 0.2, so we don't
      // assert monotonic decay — only that the level stays finite and within
      // a physiological envelope.
      stepFor(engine, 120);
      const settled = engine.acetylcholine;
      expect(Number.isFinite(settled)).toBe(true);
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(settled).toBeLessThan(2);
    });
  });

  describe("Performance / Stability", () => {
    it("survives a 600-step burn-in without producing NaN in any buffer", () => {
      stepFor(engine, 600);
      for (let i = 0; i < engine.regionIntensity.length; i += 1) {
        expect(Number.isFinite(engine.regionIntensity[i])).toBe(true);
      }
      for (let i = 0; i < engine.pathwayIntensity.length; i += 1) {
        expect(Number.isFinite(engine.pathwayIntensity[i])).toBe(true);
      }
    });

    it("connectome weights remain finite under STDP for 600 steps", () => {
      stepFor(engine, 600);
      const weights = engine.getConnectomeWeights();
      expect(weights).toBeInstanceOf(Float32Array);
      let allFinite = true;
      for (let i = 0; i < weights.length; i += 1) {
        if (!Number.isFinite(weights[i])) {
          allFinite = false;
          break;
        }
      }
      expect(allFinite).toBe(true);
    });
  });

  describe("Visualization Integration", () => {
    it("neuronType length matches graph.nodes.length (E/I raster compatible)", () => {
      expect(engine.neuronType.length).toBe(graph.nodes.length);
    });

    it("burstStatus and memoryTrace, when non-null, are correctly sized Float32Arrays", () => {
      stepFor(engine, 30);
      const burst = engine.getBurstStatus();
      const trace = engine.getMemoryTrace();
      if (burst !== null) {
        expect(burst).toBeInstanceOf(Float32Array);
        expect(burst.length).toBe(graph.nodes.length);
      }
      if (trace !== null) {
        expect(trace).toBeInstanceOf(Float32Array);
        expect(trace.length).toBe(graph.nodes.length);
      }
      // At least the renderer-facing capability check the BrainScene relies on.
      expect(isSpikingCapable(engine)).toBe(true);
    });

    it("regionIntensity stays in [0,1] after long burn-in", () => {
      stepFor(engine, 300);
      for (let i = 0; i < engine.regionIntensity.length; i += 1) {
        expect(engine.regionIntensity[i]).toBeGreaterThanOrEqual(0);
        expect(engine.regionIntensity[i]).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("Emergent Cognitive Behaviors", () => {
    it("applyCognitiveState(FOCUS_STATE / RECALL / CREATIVE) keeps the engine finite", () => {
      for (const state of [FOCUS_STATE, RECALL_MEMORY_STATE, CREATIVE_THINKING_STATE]) {
        engine.applyCognitiveState(state);
        stepFor(engine, 30);
        expect(Number.isFinite(engine.getFreeEnergy())).toBe(true);
        expect(Number.isFinite(engine.dopamine)).toBe(true);
      }
    });

    it("handleReplayEvent(hippocampus) drives a memory trace + ACh pulse", () => {
      stepFor(engine, 30);
      const beforeACh = engine.acetylcholine;
      const event: ReplayEvent = {
        type: "replay",
        memoryIds: ["m-1", "m-2"],
        region: "hippocampus",
        thetaPhase: "peak",
        timestamp: new Date().toISOString(),
      };
      engine.handleReplayEvent(event);
      stepFor(engine, 5);
      const trace = engine.getMemoryTrace();
      expect(trace).not.toBeNull();
      // ACh should have been pulsed up by the replay (volume-transmission +0.15).
      expect(engine.acetylcholine).toBeGreaterThan(beforeACh);
    });

    it("serializeCore() → loadCoreState() preserves connectome weights bit-exactly", () => {
      stepFor(engine, 60); // let STDP move the weights off the seed values
      const snapshot = engine.serializeCore();
      const beforeReload = engine.getConnectomeWeights().slice();

      // Take a fresh engine and load the snapshot into it.
      const fresh = new SpikingEngine(buildGraph(), "see-object");
      const ok = fresh.loadCoreState(snapshot);
      expect(ok).toBe(true);
      const afterReload = fresh.getConnectomeWeights();

      expect(afterReload.length).toBe(beforeReload.length);
      let bitExact = true;
      for (let i = 0; i < beforeReload.length; i += 1) {
        if (afterReload[i] !== beforeReload[i]) {
          bitExact = false;
          break;
        }
      }
      expect(bitExact).toBe(true);
    });
  });
});
