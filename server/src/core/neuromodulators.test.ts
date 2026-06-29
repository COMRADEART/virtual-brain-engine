import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decayLevel,
  decayLevels,
  applyPulse,
  learningRateScale,
  shouldBroadenFromArousal,
  wantsFreshData,
  moodExploreBias,
  underStress,
  socialTrustScale,
  pulsesForCycle,
  BASELINE,
  HALF_LIFE_MS,
  NE_BROADEN_FLOOR,
  ACH_AUGMENT_FLOOR,
  CORTISOL_STRESS_FLOOR,
  type ModulatorLevels,
} from "./neuromodulators.js";

const approx = (actual: number, expected: number, eps = 1e-9): void => {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
};

// Build a full ModulatorLevels from partial overrides on top of baseline.
const levels = (over: Partial<ModulatorLevels> = {}): ModulatorLevels => ({
  ...BASELINE,
  ...over,
});

// -----------------------------------------------------------------------------
// decayLevel — the load-bearing exponential decay (0.5^(dt/halfLife)).
// -----------------------------------------------------------------------------

test("decayLevel halves the deviation from baseline after exactly one half-life", () => {
  // level 1, baseline 0: after one half-life the deviation (1) is halved → 0.5.
  assert.equal(decayLevel(1, 0, 100, 100), 0.5);
});

test("decayLevel quarters then eighths the deviation at 2 and 3 half-lives", () => {
  assert.equal(decayLevel(1, 0, 200, 100), 0.25);
  assert.equal(decayLevel(1, 0, 300, 100), 0.125);
});

test("decayLevel decays toward baseline from BELOW, not just above", () => {
  // level 0, baseline 1: rises halfway toward baseline after one half-life.
  assert.equal(decayLevel(0, 1, 100, 100), 0.5);
});

test("decayLevel is monotonic: more elapsed time lands strictly closer to baseline", () => {
  const d100 = decayLevel(1, 0, 100, 100); // 0.5
  const d300 = decayLevel(1, 0, 300, 100); // 0.125
  const d900 = decayLevel(1, 0, 900, 100); // ~0.00195
  assert.ok(d100 > d300 && d300 > d900, "decay must approach baseline monotonically");
  assert.ok(d900 > 0, "still above a baseline of 0");
});

test("decayLevel is a no-op for dt<=0 (returns the clamped level, never moves toward baseline)", () => {
  assert.equal(decayLevel(0.7, 0.2, 0, 100), 0.7);
  assert.equal(decayLevel(0.7, 0.2, -500, 100), 0.7);
});

test("decayLevel is a no-op when halfLife is non-positive (guards divide-by-zero blowup)", () => {
  assert.equal(decayLevel(0.7, 0.2, 100, 0), 0.7);
  assert.equal(decayLevel(0.7, 0.2, 100, -10), 0.7);
});

test("decayLevel clamps an out-of-range level into [0,1] before decaying", () => {
  // clamp01(5)=1, then 0 + (1-0)*0.5 = 0.5
  assert.equal(decayLevel(5, 0, 100, 100), 0.5);
  // dt<=0 path also clamps: clamp01(-3)=0
  assert.equal(decayLevel(-3, 0.5, 0, 100), 0);
});

test("decayLevel treats a non-finite level as 0 (NaN never propagates)", () => {
  // dt>0 path: clamp01(NaN)=0 → 0.4 + (0-0.4)*0.5 = 0.2
  approx(decayLevel(NaN, 0.4, 100, 100), 0.2);
  // dt<=0 path: returns clamp01(NaN)=0
  assert.equal(decayLevel(NaN, 0.5, 0, 100), 0);
});

// -----------------------------------------------------------------------------
// decayLevels — applies decayLevel per-key with the right baseline/half-life pair.
// -----------------------------------------------------------------------------

test("decayLevels is a no-op at dt=0 — every level passes through unchanged (clamped)", () => {
  const start = levels({ dopamine: 0.9, norepinephrine: 0.8, cortisol: 0.7 });
  assert.deepEqual(decayLevels(start, 0), start);
});

test("decayLevels pairs each modulator with its OWN baseline and half-life", () => {
  // Drive every level to 1.0; verify a specific key matches the scalar decayLevel
  // wired with that key's baseline+half-life. Catches a swapped constant.
  const all1: ModulatorLevels = {
    dopamine: 1,
    norepinephrine: 1,
    acetylcholine: 1,
    serotonin: 1,
    cortisol: 1,
    oxytocin: 1,
  };
  const dt = HALF_LIFE_MS.norepinephrine; // one NE half-life
  const out = decayLevels(all1, dt);
  // NE at one half-life: 0.2 + (1-0.2)*0.5 = 0.6
  approx(out.norepinephrine, 0.6);
  // Same dt is a much smaller step for the slow serotonin (180m) than for NE (10m).
  assert.ok(
    out.serotonin > out.norepinephrine,
    "serotonin (slow half-life) must stay far above its NE-paced sibling",
  );
  assert.equal(out.cortisol, decayLevel(1, BASELINE.cortisol, dt, HALF_LIFE_MS.cortisol));
});

test("decayLevels drives every level back to baseline after very long elapsed time", () => {
  const start = levels({ dopamine: 1, norepinephrine: 1, acetylcholine: 1, serotonin: 1, cortisol: 1, oxytocin: 1 });
  // 50 half-lives of the SLOWEST modulator (serotonin, 180m) — guarantees every
  // level is within rounding of baseline. (1000 minutes was only ~5.5 serotonin
  // half-lives, leaving it at 0.51, not 0.50.)
  const slowestHalfLife = Math.max(...Object.values(HALF_LIFE_MS));
  const out = decayLevels(start, slowestHalfLife * 50);
  for (const k of Object.keys(BASELINE) as (keyof ModulatorLevels)[]) {
    approx(out[k], BASELINE[k], 1e-3);
  }
});

// -----------------------------------------------------------------------------
// applyPulse — additive pulse, clamped, finite-guarded.
// -----------------------------------------------------------------------------

test("applyPulse adds a positive delta and clamps the ceiling at 1", () => {
  approx(applyPulse(0.5, 0.2), 0.7);
  assert.equal(applyPulse(0.9, 0.2), 1);
});

test("applyPulse subtracts a negative delta and clamps the floor at 0", () => {
  assert.equal(applyPulse(0.1, -0.5), 0);
});

test("applyPulse treats a non-finite delta as zero", () => {
  assert.equal(applyPulse(0.5, NaN), 0.5);
  assert.equal(applyPulse(0.5, Infinity), 0.5);
});

test("applyPulse clamps an out-of-range starting level before adding", () => {
  assert.equal(applyPulse(5, 0.1), 1); // clamp01(5)=1, +0.1 → 1
  approx(applyPulse(NaN, 0.3), 0.3); // clamp01(NaN)=0, +0.3
});

// -----------------------------------------------------------------------------
// Consumer gates/scales — each must be a strict no-op at its baseline.
// -----------------------------------------------------------------------------

test("learningRateScale is EXACTLY 1.0 at baseline dopamine (strict no-op contract)", () => {
  assert.equal(learningRateScale(levels()), 1);
});

test("learningRateScale spans [0.5, 1.5] across dopamine [0,1] and clamps beyond", () => {
  assert.equal(learningRateScale(levels({ dopamine: 0 })), 0.5);
  assert.equal(learningRateScale(levels({ dopamine: 1 })), 1.5);
  assert.equal(learningRateScale(levels({ dopamine: 2 })), 1.5); // clamped
});

test("shouldBroadenFromArousal triggers at/above the NE floor and is off at baseline", () => {
  assert.equal(shouldBroadenFromArousal(levels({ norepinephrine: NE_BROADEN_FLOOR })), true);
  assert.equal(shouldBroadenFromArousal(levels({ norepinephrine: NE_BROADEN_FLOOR - 0.01 })), false);
  assert.equal(shouldBroadenFromArousal(levels()), false); // baseline 0.2
});

test("wantsFreshData triggers at/above the ACh floor and is off at baseline", () => {
  assert.equal(wantsFreshData(levels({ acetylcholine: ACH_AUGMENT_FLOOR })), true);
  assert.equal(wantsFreshData(levels({ acetylcholine: ACH_AUGMENT_FLOOR - 0.01 })), false);
  assert.equal(wantsFreshData(levels()), false);
});

test("underStress triggers at/above the cortisol floor and is off at baseline", () => {
  assert.equal(underStress(levels({ cortisol: CORTISOL_STRESS_FLOOR })), true);
  assert.equal(underStress(levels({ cortisol: CORTISOL_STRESS_FLOOR - 0.01 })), false);
  assert.equal(underStress(levels()), false);
});

test("moodExploreBias is EXACTLY 0 at baseline serotonin and inverts with mood direction", () => {
  assert.equal(moodExploreBias(levels()), 0); // baseline 0.5
  // LOW mood → MORE exploration (positive bias); high mood → less (negative).
  approx(moodExploreBias(levels({ serotonin: 0.2 })), 0.09);
  approx(moodExploreBias(levels({ serotonin: 0.8 })), -0.09);
  assert.ok(moodExploreBias(levels({ serotonin: 0.1 })) > 0);
});

test("socialTrustScale is EXACTLY 1.0 at baseline oxytocin and rises with bonding", () => {
  assert.equal(socialTrustScale(levels()), 1); // baseline 0.2
  approx(socialTrustScale(levels({ oxytocin: 1 })), 1.4); // 1 + (1-0.2)*0.5
  assert.equal(socialTrustScale(levels({ oxytocin: 5 })), 1.4); // clamped at 1
});

// -----------------------------------------------------------------------------
// pulsesForCycle — maps one reasoning cycle onto modulator deltas.
// -----------------------------------------------------------------------------

test("pulsesForCycle: a grounded confident cited answer rewards + relieves uncertainty", () => {
  const p = pulsesForCycle({ confidence: 0.9, citedCount: 3, contradictions: 0 });
  approx(p.dopamine, 0.15); // 0.05*3, capped at 0.15
  assert.equal(p.norepinephrine, 0); // no contradictions
  approx(p.acetylcholine, -0.1); // grounded → relieves data-hunger
  approx(p.serotonin, 0.08); // mood lifts
  approx(p.cortisol, -0.05); // clean confident answer relieves stress
  assert.equal(p.oxytocin, 0); // bonding only from explicit feedback
});

test("pulsesForCycle: an ungrounded low-confidence drought builds uncertainty + stress", () => {
  const p = pulsesForCycle({ confidence: 0.1, citedCount: 0, contradictions: 0 });
  approx(p.dopamine, -0.03); // reward drought
  approx(p.acetylcholine, 0.18); // (1-0.1)*0.2 — hungry for fresh data
  approx(p.serotonin, -0.05); // mood dips on a zero-citation cycle
  approx(p.cortisol, 0.06); // conf<0.4 raises stress
  assert.equal(p.norepinephrine, 0);
});

test("pulsesForCycle: contradictions drive arousal AND stress proportionally", () => {
  const p = pulsesForCycle({ confidence: 0.5, citedCount: 1, contradictions: 2 });
  approx(p.norepinephrine, 0.2); // 0.1*2
  approx(p.cortisol, 0.2); // 0.1*2 (contradiction path wins over the conf path)
  approx(p.dopamine, 0.05); // 0.05*1
  approx(p.acetylcholine, -0.1); // grounded (cited>0 && conf>=0.5)
});

test("pulsesForCycle caps dopamine/NE/cortisol so a runaway cycle cannot saturate", () => {
  const p = pulsesForCycle({ confidence: 1, citedCount: 100, contradictions: 100 });
  assert.equal(p.dopamine, 0.15);
  assert.equal(p.norepinephrine, 0.3);
  assert.equal(p.cortisol, 0.3);
});

test("pulsesForCycle sanitizes inputs: clamps confidence, floors counts, drops negatives", () => {
  // confidence 2 → 1; citedCount 2.9 → 2; contradictions -5 → 0
  const p = pulsesForCycle({ confidence: 2, citedCount: 2.9, contradictions: -5 });
  approx(p.dopamine, 0.1); // 0.05 * floor(2.9)=2
  assert.equal(p.norepinephrine, 0); // negative contradictions floored to 0
  approx(p.cortisol, -0.05); // no contradictions, conf>=0.4 → relief
});
