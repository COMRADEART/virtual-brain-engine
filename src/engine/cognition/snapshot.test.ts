// Phase 4 (improvement plan §10) — BrainSnapshot round-trip verification.
//
// The plan's DoD is "snapshot round-trip restores identical state for a fixed
// seed". Code paths exist in HybridCognitiveCore.serialize() / applySnapshot()
// and persistence.ts, but until this test ran, nothing actually exercised the
// full serialize → apply → re-serialize loop. This file proves the contract.

import { describe, expect, it } from "vitest";
import { generateNeuralGraph } from "../neuralGraphGenerator";
import { HybridCognitiveCore } from "./HybridCognitiveCore";

function makeCore(density = 0.18, seed = 191): HybridCognitiveCore {
  const graph = generateNeuralGraph({ density, seed });
  return new HybridCognitiveCore(graph, "attentional-blink", {
    density,
    seed,
    attachRewardSource: false,
  });
}

describe("BrainSnapshot round-trip", () => {
  it("serialize → applySnapshot → re-serialize produces identical state", () => {
    const a = makeCore();
    // Advance a few frames so the inner state diverges from the construction default.
    for (let i = 0; i < 5; i += 1) a.step(1 / 60, i / 60);

    const snap = a.serialize();
    expect(snap.version).toBe(2);
    expect(snap.density).toBeCloseTo(0.18, 9);
    expect(snap.graphSeed).toBe(191);

    const b = makeCore();
    const applied = (b as unknown as { applySnapshot(s: typeof snap): boolean }).applySnapshot(snap);
    expect(applied).toBe(true);

    const after = b.serialize();
    // Connectome weights are the dominant payload — exact equality across copy.
    expect(after.connectomeWeights.length).toBe(snap.connectomeWeights.length);
    for (let i = 0; i < snap.connectomeWeights.length; i += 1) {
      expect(after.connectomeWeights[i]).toBeCloseTo(snap.connectomeWeights[i], 9);
    }
    // Neuromodulator levels round-trip exactly.
    expect(after.neuromod.dopamine).toBeCloseTo(snap.neuromod.dopamine, 9);
    expect(after.neuromod.acetylcholine).toBeCloseTo(snap.neuromod.acetylcholine, 9);
    expect(after.neuromod.serotonin).toBeCloseTo(snap.neuromod.serotonin, 9);
    expect(after.neuromod.norepinephrine).toBeCloseTo(snap.neuromod.norepinephrine, 9);
    // Hyperparameter genome round-trips on every named field.
    for (const k of Object.keys(snap.hyperparams) as Array<keyof typeof snap.hyperparams>) {
      expect(after.hyperparams[k]).toBeCloseTo(snap.hyperparams[k], 9);
    }
    // EWC importance vector — same length, same values.
    expect(after.ewcImportance.length).toBe(snap.ewcImportance.length);
    for (let i = 0; i < snap.ewcImportance.length; i += 1) {
      expect(after.ewcImportance[i]).toBeCloseTo(snap.ewcImportance[i], 9);
    }
    // IQ history bounded; whatever's there before should be there after.
    expect(after.iqHistory).toEqual(snap.iqHistory);
    // Value function — key set and per-key values match.
    const before = new Map(snap.valueFunction);
    const aft = new Map(after.valueFunction);
    expect(aft.size).toBe(before.size);
    for (const [k, v] of before) expect(aft.get(k)).toBeCloseTo(v, 9);
  });

  it("rejects a snapshot built against a different topology", () => {
    const a = makeCore(0.18, 191);
    const snap = a.serialize();
    const b = makeCore(0.18, 999); // different seed
    const applied = (b as unknown as { applySnapshot(s: typeof snap): boolean }).applySnapshot(snap);
    expect(applied).toBe(false);
  });
});
