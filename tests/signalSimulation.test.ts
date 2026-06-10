import { describe, it, expect } from "vitest";
import { generateNeuralGraph } from "../src/engine/neuralGraphGenerator";
import { SignalSimulation } from "../src/engine/signalSimulation";
import { ACTION_BY_ID } from "../src/engine/brainRegions";
import type { NeuralGraph } from "../src/engine/types";

// Baseline contract test for the per-frame engine loop the renderer drives
// (BrainScene calls simulation.step(delta, elapsed) every requestAnimationFrame).
// "see-object" is a non-emergent action, so initializeEmergentAction() is a no-op
// and the simulation never reads Date.now() — keeping step() fully deterministic
// under the class's seeded RNG (mulberry32(381)).
const ACTION = "see-object";
const FIXED_DELTA = 1 / 60;

function buildGraph(): NeuralGraph {
  // Small, fixed graph so the suite stays fast and reproducible.
  return generateNeuralGraph({ density: 0.25, seed: 19 });
}

function buildSim(graph: NeuralGraph): SignalSimulation {
  return new SignalSimulation(graph, ACTION);
}

/** Advance the simulation `steps` frames at a fixed delta. */
function run(sim: SignalSimulation, steps: number): void {
  let elapsed = 0;
  for (let i = 0; i < steps; i += 1) {
    elapsed += FIXED_DELTA;
    sim.step(FIXED_DELTA, elapsed);
  }
}

describe("SignalSimulation — engine loop", () => {
  it("allocates intensity buffers matching the graph topology", () => {
    const graph = buildGraph();
    const sim = buildSim(graph);

    expect(sim.regionIntensity).toBeInstanceOf(Float32Array);
    expect(sim.regionIntensity.length).toBe(graph.regionOrder.length);
    expect(sim.regionFlashIntensity.length).toBe(graph.regionOrder.length);
    expect(sim.pathwayIntensity.length).toBe(graph.pathways.length);
    expect(sim.pulses).toHaveLength(0);
  });

  it("propagates activity into the active regions after stepping", () => {
    const graph = buildGraph();
    const sim = buildSim(graph);

    expect(ACTION_BY_ID[ACTION].activeRegions.length).toBeGreaterThan(0);

    run(sim, 120);

    let maxRegion = 0;
    for (const value of sim.regionIntensity) {
      maxRegion = Math.max(maxRegion, value);
    }
    expect(maxRegion).toBeGreaterThan(0);
    expect(sim.pulses.length).toBeGreaterThan(0);
  });

  it("keeps every intensity finite and within [0, 1]", () => {
    const graph = buildGraph();
    const sim = buildSim(graph);
    run(sim, 200);

    const channels = [sim.regionIntensity, sim.regionFlashIntensity, sim.pathwayIntensity];
    for (const channel of channels) {
      for (const value of channel) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it("never exceeds the configured pulse cap", () => {
    const graph = buildGraph();
    const sim = buildSim(graph);
    sim.setMaxPulses(40);
    sim.setSpeed(4); // push hard against the cap

    run(sim, 400);

    expect(sim.pulses.length).toBeLessThanOrEqual(40);
  });

  it("is deterministic: identical inputs yield identical state", () => {
    const graphA = buildGraph();
    const graphB = buildGraph();
    const simA = buildSim(graphA);
    const simB = buildSim(graphB);

    run(simA, 150);
    run(simB, 150);

    expect(Array.from(simA.regionIntensity)).toEqual(Array.from(simB.regionIntensity));
    expect(Array.from(simA.pathwayIntensity)).toEqual(Array.from(simB.pathwayIntensity));
    expect(simA.pulses.length).toBe(simB.pulses.length);

    const project = (sim: SignalSimulation) =>
      sim.pulses.map((p) => ({
        pathwayIndex: p.pathwayIndex,
        fromNode: p.fromNode,
        toNode: p.toNode,
        progress: p.progress,
        velocity: p.velocity,
        intensity: p.intensity,
      }));
    expect(project(simA)).toEqual(project(simB));
  });

  it("spawns no new pulses while paused, and still decays existing activity", () => {
    const graph = buildGraph();
    const sim = buildSim(graph);
    run(sim, 120);

    const seeded = sim.pulses.length;
    expect(seeded).toBeGreaterThan(0);

    let peak = 0;
    for (const value of sim.regionIntensity) peak = Math.max(peak, value);

    sim.setRunning(false);
    run(sim, 60);

    // No new pulses appear; the pool only shrinks as in-flight pulses finish.
    expect(sim.pulses.length).toBeLessThanOrEqual(seeded);

    let after = 0;
    for (const value of sim.regionIntensity) after = Math.max(after, value);
    expect(after).toBeLessThan(peak);
  });

  it("resets transient state when the action changes", () => {
    const graph = buildGraph();
    const sim = buildSim(graph);
    run(sim, 120);
    expect(sim.pulses.length).toBeGreaterThan(0);

    sim.setAction("hear-sound");

    expect(sim.pulses).toHaveLength(0);
    for (const value of sim.regionIntensity) expect(value).toBe(0);
    for (const value of sim.pathwayIntensity) expect(value).toBe(0);
  });

  it("decays the memory-intensity channel toward zero over time", () => {
    const graph = buildGraph();
    const sim = buildSim(graph);
    sim.setMemoryIntensity(500); // saturates to 1.0
    expect(sim.memoryIntensity).toBeCloseTo(1, 5);

    sim.setRunning(false);
    run(sim, 120);

    expect(sim.memoryIntensity).toBeLessThan(1);
    expect(sim.memoryIntensity).toBeGreaterThanOrEqual(0);
  });
});
