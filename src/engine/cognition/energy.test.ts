// Phase 1 (blueprint §18.1) — unified cognitive energy ledger tests.

import { describe, expect, it } from "vitest";
import { EnergyLedger, fatigueToUncertainty, type EnergyConsumer } from "./energy";

describe("EnergyLedger", () => {
  it("starts full and reports zero fatigue", () => {
    const led = new EnergyLedger();
    expect(led.energy()).toBeCloseTo(1, 9);
    expect(led.fatigue()).toBeCloseTo(0, 9);
  });

  it("respects custom initial / floor", () => {
    const led = new EnergyLedger({ initial: 0.5, floor: 0.2 });
    expect(led.energy()).toBeCloseTo(0.5, 9);
    // Drain past the floor: stops at the floor, returns taken amount only.
    const taken = led.debit("attention", 0.9);
    expect(led.energy()).toBeCloseTo(0.2, 9);
    expect(taken).toBeCloseTo(0.3, 9);
  });

  it("clamps the constructor initial to [floor,1]", () => {
    const high = new EnergyLedger({ initial: 5 });
    expect(high.energy()).toBe(1);
    const low = new EnergyLedger({ initial: -1, floor: 0.1 });
    expect(low.energy()).toBe(0.1);
  });

  it("debit lowers energy and raises fatigue (convex)", () => {
    const led = new EnergyLedger();
    led.debit("system2", 0.5);
    expect(led.energy()).toBeCloseTo(0.5, 9);
    // fatigue = 1 - energy^2 = 1 - 0.25 = 0.75
    expect(led.fatigue()).toBeCloseTo(0.75, 9);
  });

  it("debit is non-decreasing in fatigue (monotone)", () => {
    const led = new EnergyLedger();
    let last = led.fatigue();
    for (let i = 0; i < 10; i += 1) {
      led.debit("system2", 0.05);
      const f = led.fatigue();
      expect(f).toBeGreaterThanOrEqual(last - 1e-12);
      last = f;
    }
  });

  it("ignores invalid debits (NaN, negative, zero)", () => {
    const led = new EnergyLedger();
    expect(led.debit("other", Number.NaN)).toBe(0);
    expect(led.debit("other", -0.3)).toBe(0);
    expect(led.debit("other", 0)).toBe(0);
    expect(led.energy()).toBeCloseTo(1, 9);
  });

  it("refresh regenerates at regenPerSecond * dt, capped at 1", () => {
    const led = new EnergyLedger({ regenPerSecond: 0.1 });
    led.debit("attention", 0.6); // energy=0.4
    led.refresh(2); // +0.2 → 0.6
    expect(led.energy()).toBeCloseTo(0.6, 9);
    led.refresh(100); // would overshoot, but capped at 1
    expect(led.energy()).toBeCloseTo(1, 9);
  });

  it("refresh ignores invalid dt", () => {
    const led = new EnergyLedger();
    led.debit("attention", 0.5);
    led.refresh(Number.NaN);
    led.refresh(-1);
    led.refresh(0);
    expect(led.energy()).toBeCloseTo(0.5, 9);
  });

  it("canSpend reflects floor", () => {
    const led = new EnergyLedger({ initial: 0.3, floor: 0.2 });
    expect(led.canSpend("system2", 0.05)).toBe(true);
    expect(led.canSpend("system2", 0.2)).toBe(false); // would breach floor
  });

  it("snapshot reports per-consumer totals", () => {
    const led = new EnergyLedger();
    led.debit("attention", 0.1);
    led.debit("system2", 0.2);
    led.debit("attention", 0.05);
    const snap = led.snapshot();
    expect(snap.byConsumer.attention).toBeCloseTo(0.15, 9);
    expect(snap.byConsumer.system2).toBeCloseTo(0.2, 9);
    expect(snap.totalDebited).toBeCloseTo(0.35, 9);
  });

  it("reset returns the ledger to a fresh state", () => {
    const led = new EnergyLedger();
    led.debit("attention", 0.5);
    led.reset(1);
    expect(led.energy()).toBeCloseTo(1, 9);
    expect(led.snapshot().totalDebited).toBe(0);
    for (const v of Object.values(led.snapshot().byConsumer)) expect(v).toBe(0);
  });

  it("fatigue is exactly 0 at full energy and exactly 1 at zero energy", () => {
    const led = new EnergyLedger();
    expect(led.fatigue()).toBe(0);
    led.debit("other", 1); // drain to floor=0
    expect(led.energy()).toBe(0);
    expect(led.fatigue()).toBe(1);
  });

  it("fatigueToUncertainty is a 1:1 clamp (current first-cut tuning)", () => {
    expect(fatigueToUncertainty(0)).toBe(0);
    expect(fatigueToUncertainty(1)).toBe(1);
    expect(fatigueToUncertainty(0.42)).toBeCloseTo(0.42, 9);
    expect(fatigueToUncertainty(2)).toBe(1);
    expect(fatigueToUncertainty(-3)).toBe(0);
    expect(fatigueToUncertainty(Number.NaN)).toBe(0);
  });

  it("per-consumer tagging covers every EnergyConsumer value", () => {
    const led = new EnergyLedger();
    const all: EnergyConsumer[] = [
      "attention",
      "system2",
      "prefetch",
      "imagination",
      "memory-write",
      "other",
    ];
    for (const tag of all) led.debit(tag, 0.05);
    const snap = led.snapshot();
    for (const tag of all) expect(snap.byConsumer[tag]).toBeCloseTo(0.05, 9);
  });
});
