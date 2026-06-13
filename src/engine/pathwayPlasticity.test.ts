// Self-improving pathways — pure plasticity layer. Deterministic given the rng
// passed to pick(), so every invariant below is testable as plain functions.

import { describe, expect, it } from "vitest";
import { PathwayPlasticity } from "./pathwayPlasticity";

describe("PathwayPlasticity", () => {
  it("starts every pathway at the 1.0 baseline with zero glow", () => {
    const p = new PathwayPlasticity(4);
    for (let i = 0; i < 4; i++) {
      expect(p.weight[i]).toBe(1);
      expect(p.strength(i)).toBe(0);
      expect(p.floor(i)).toBe(0);
    }
  });

  it("potentiation strengthens a route and raises its persistent glow floor", () => {
    const p = new PathwayPlasticity(2, { potentiateRate: 0.5, maxWeight: 4 });
    p.potentiate(0, 1);
    expect(p.weight[0]).toBeCloseTo(1.5, 6);
    expect(p.strength(0)).toBeGreaterThan(0);
    expect(p.floor(0)).toBeGreaterThan(0);
    // Untouched route stays at baseline.
    expect(p.weight[1]).toBe(1);
  });

  it("clamps weight at maxWeight no matter how much it is potentiated", () => {
    const p = new PathwayPlasticity(1, { potentiateRate: 1, maxWeight: 3 });
    for (let i = 0; i < 100; i++) p.potentiate(0, 1);
    expect(p.weight[0]).toBe(3);
    expect(p.strength(0)).toBeCloseTo(1, 6);
  });

  it("decay relaxes a strengthened route back toward baseline", () => {
    const p = new PathwayPlasticity(1, { potentiateRate: 2, decayPerSecond: 0.5, maxWeight: 5 });
    p.potentiate(0, 1); // weight = 3
    p.decay(1); // (3-1)*0.5 + 1 = 2
    expect(p.weight[0]).toBeCloseTo(2, 6);
    p.decay(1); // (2-1)*0.5 + 1 = 1.5
    expect(p.weight[0]).toBeCloseTo(1.5, 6);
  });

  it("decay never drops a weight below baseline and is a no-op at baseline", () => {
    const p = new PathwayPlasticity(2, { decayPerSecond: 0.1 });
    p.decay(10);
    expect(p.weight[0]).toBe(1);
    expect(p.weight[1]).toBe(1);
  });

  it("pick biases selection toward the stronger route", () => {
    const p = new PathwayPlasticity(2, { potentiateRate: 3, maxWeight: 10 });
    p.potentiate(1, 1); // weight[1] = 4 vs weight[0] = 1 → 80% mass on route 1
    let chose1 = 0;
    let seed = 0;
    // Deterministic LCG so the test never flakes.
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 2000; i++) {
      if (p.pick([0, 1], rng) === 1) chose1++;
    }
    expect(chose1).toBeGreaterThan(1200); // well above the 50/50 a uniform pick gives
  });

  it("pick handles empty and singleton candidate lists", () => {
    const p = new PathwayPlasticity(3);
    expect(p.pick([], () => 0.5)).toBe(-1);
    expect(p.pick([2], () => 0.5)).toBe(2);
  });
});
