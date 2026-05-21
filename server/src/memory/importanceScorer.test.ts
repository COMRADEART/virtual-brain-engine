import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeImportance,
  applyImportanceBoost,
  applyDecay,
  getImportanceTier,
  type ImportanceFactors,
} from "./importanceScorer.js";

function factors(overrides: Partial<ImportanceFactors> = {}): ImportanceFactors {
  return {
    baseImportance: 0.5,
    ageDays: 0,
    citationCount: 0,
    projectBoost: 0,
    sourceType: "chunk",
    contentLength: 100,
    ...overrides,
  };
}

test("computeImportance clamps to the [0.02, 1.0] band", () => {
  const high = computeImportance(
    factors({ baseImportance: 5, citationCount: 50, projectBoost: 1, sourceType: "manual" }),
  );
  assert.equal(high.score, 1.0); // hard ceiling

  const low = computeImportance(factors({ baseImportance: 0.0001, ageDays: 365 }));
  assert.ok(low.score >= 0.02, `floor held, got ${low.score}`);
});

test("recency is monotonically non-increasing with age", () => {
  const fresh = computeImportance(factors({ ageDays: 0 })).breakdown.recencyScore;
  const week = computeImportance(factors({ ageDays: 7 })).breakdown.recencyScore;
  const month = computeImportance(factors({ ageDays: 30 })).breakdown.recencyScore;
  assert.ok(fresh > week && week > month, `${fresh} > ${week} > ${month}`);
});

test("frequency boost is 1.0 at zero citations and rises but stays bounded", () => {
  const none = computeImportance(factors({ citationCount: 0 })).breakdown.frequencyScore;
  const some = computeImportance(factors({ citationCount: 5 })).breakdown.frequencyScore;
  const many = computeImportance(factors({ citationCount: 1000 })).breakdown.frequencyScore;
  assert.equal(none, 1.0);
  assert.ok(some > none);
  assert.ok(many <= 3.0, `MAX_CITATION_BOOST ceiling, got ${many}`);
});

test("applyImportanceBoost caps the per-call delta and the absolute ceiling", () => {
  // delta is min(0.15, citationDelta*0.05): a huge citationDelta still adds <= 0.15
  assert.ok(applyImportanceBoost(0.5, 100) - 0.5 <= 0.15 + 1e-9);
  // never exceeds MAX_IMPORTANCE
  assert.equal(applyImportanceBoost(0.99, 100), 1.0);
});

test("applyDecay clamps the floor for stale rows", () => {
  assert.ok(applyDecay(0.03, 3650) >= 0.02);
});

test("applyDecay clamps the ceiling for negative ageDays (L2 regression)", () => {
  // clock skew / updatedAt in the future -> recencyFactor > 1; must not inflate
  const decayed = applyDecay(0.9, -90);
  assert.ok(decayed <= 1.0, `must not exceed MAX_IMPORTANCE, got ${decayed}`);
});

test("getImportanceTier maps the documented boundaries", () => {
  assert.equal(getImportanceTier(0.6), "high");
  assert.equal(getImportanceTier(0.59), "medium");
  assert.equal(getImportanceTier(0.3), "medium");
  assert.equal(getImportanceTier(0.29), "low");
  assert.equal(getImportanceTier(0.1), "low");
  assert.equal(getImportanceTier(0.09), "forget");
});
