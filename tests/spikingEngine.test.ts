import { describe, it, expect } from "vitest";
import { generateNeuralGraph } from "../src/engine/neuralGraphGenerator";
import { SpikingEngine } from "../src/engine/SpikingEngine";
import { isSpikingCapable } from "../src/engine/types";
import type { NeuralGraph } from "../src/engine/types";

// Real-API smoke test for the biologically-plausible engine.
// `SpikingEngine` is a compatibility alias for `AdvancedBrainCore`; this asserts
// the contract the renderer actually relies on (BrainScene gates visual effects on
// `isSpikingCapable(sim)` and then reads neuronType / getBurstStatus / neuromodulators).
// It deliberately avoids asserting specific firing-rate/biology thresholds — those
// belong in the quarantined neuroscienceValidation suite once ported.
const FIXED_DELTA = 1 / 60;

function buildGraph(): NeuralGraph {
  return generateNeuralGraph({ density: 0.2, seed: 19 });
}

describe("SpikingEngine (AdvancedBrainCore) — real API contract", () => {
  it("constructs with the standard (graph, action) shape and sizes its buffers", () => {
    const graph = buildGraph();
    const engine = new SpikingEngine(graph, "see-object");

    expect(engine.regionIntensity).toBeInstanceOf(Float32Array);
    expect(engine.regionIntensity.length).toBe(graph.regionOrder.length);
    expect(engine.pathwayIntensity.length).toBe(graph.pathways.length);
    expect(engine.neuronType).toBeInstanceOf(Int8Array);
    expect(engine.neuronType.length).toBe(graph.nodes.length);
  });

  it("satisfies the isSpikingCapable() guard the renderer feature-detects on", () => {
    const engine = new SpikingEngine(buildGraph(), "see-object");
    expect(isSpikingCapable(engine)).toBe(true);
    expect(typeof engine.getBurstStatus).toBe("function");
    expect(typeof engine.getMemoryTrace).toBe("function");
  });

  it("steps without throwing and keeps intensities finite", () => {
    const engine = new SpikingEngine(buildGraph(), "see-object");
    let elapsed = 0;
    for (let i = 0; i < 120; i += 1) {
      elapsed += FIXED_DELTA;
      engine.step(FIXED_DELTA, elapsed);
    }

    for (const value of engine.regionIntensity) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    for (const value of engine.pathwayIntensity) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("exposes finite neuromodulator scalars", () => {
    const engine = new SpikingEngine(buildGraph(), "see-object");
    engine.step(FIXED_DELTA, FIXED_DELTA);

    for (const level of [
      engine.dopamine,
      engine.acetylcholine,
      engine.serotonin,
      engine.norepinephrine,
    ]) {
      expect(Number.isFinite(level)).toBe(true);
      expect(level).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isFinite(engine.thetaPhase)).toBe(true);
    expect(Number.isFinite(engine.gammaPhase)).toBe(true);
  });

  it("returns Float32Array | null from the optional trace getters", () => {
    const engine = new SpikingEngine(buildGraph(), "see-object");
    engine.step(FIXED_DELTA, FIXED_DELTA);

    const burst = engine.getBurstStatus();
    const trace = engine.getMemoryTrace();
    expect(burst === null || burst instanceof Float32Array).toBe(true);
    expect(trace === null || trace instanceof Float32Array).toBe(true);
  });

  it("accepts action/run/speed control without throwing", () => {
    const engine = new SpikingEngine(buildGraph(), "see-object");
    expect(() => {
      engine.setAction("hear-sound");
      engine.setSpeed(2);
      engine.setRunning(false);
      engine.step(FIXED_DELTA, FIXED_DELTA);
      engine.setRunning(true);
    }).not.toThrow();
  });
});
