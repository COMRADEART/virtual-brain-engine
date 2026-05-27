// Phase 1 selfcheck — pure proposal resolver + bus-arbiter integration.
//
// Pure module: the resolver runs without timers or a bus, so determinism +
// the softmax invariants are testable as plain functions. The arbiter test
// uses a real BrainEventBus instance (also pure) and a manual `tick()` seam
// to drive the round-trip without sleeping the test thread.

import { describe, expect, it } from "vitest";
import {
  FACULTY_IDS,
  PROPOSAL_INNER_WEIGHT_SUM,
  resolve,
  type FacultyId,
  type Proposal,
} from "./proposals";
import { BrainEventBus } from "./BrainEventBus";
import { ProposalArbiter } from "./proposalArbiter";

function mkProposal(
  faculty: FacultyId,
  score: number,
  confidence: number,
  emotionalWeight = 0.5,
  survivalRelevance = 0.0,
  at = 0,
): Proposal {
  return { faculty, score, confidence, emotionalWeight, survivalRelevance, at };
}

describe("proposals.resolve (pure)", () => {
  it("inner weight components sum to 1", () => {
    expect(PROPOSAL_INNER_WEIGHT_SUM).toBeCloseTo(1, 9);
  });

  it("empty input returns null winner + empty weights", () => {
    const r = resolve([]);
    expect(r.winner).toBeNull();
    expect(r.ranked).toEqual([]);
    expect(r.weights.size).toBe(0);
  });

  it("single proposal wins with weight 1.0", () => {
    const p = mkProposal("memory", 0.8, 0.9);
    const r = resolve([p]);
    expect(r.winner).toBe(p);
    expect(r.ranked).toEqual([p]);
    expect(r.weights.get("memory")).toBeCloseTo(1, 9);
  });

  it("higher-confidence bid wins over lower at equal score", () => {
    const lo = mkProposal("memory", 0.7, 0.2);
    const hi = mkProposal("prediction", 0.7, 0.9);
    const r = resolve([lo, hi]);
    expect(r.winner?.faculty).toBe("prediction");
    // softmax sanity: weights sum to 1
    let s = 0;
    for (const w of r.weights.values()) s += w;
    expect(s).toBeCloseTo(1, 6);
  });

  it("higher-score bid wins at equal confidence", () => {
    const lo = mkProposal("memory", 0.2, 0.7);
    const hi = mkProposal("prediction", 0.95, 0.7);
    const r = resolve([lo, hi]);
    expect(r.winner?.faculty).toBe("prediction");
  });

  it("survival relevance moves the score under tied score+confidence", () => {
    const noSurv = mkProposal("memory", 0.6, 0.6, 0.5, 0.0);
    const yesSurv = mkProposal("identity", 0.6, 0.6, 0.5, 1.0);
    const r = resolve([noSurv, yesSurv]);
    expect(r.winner?.faculty).toBe("identity");
  });

  it("is deterministic — same input → same weights", () => {
    const bids = [
      mkProposal("memory", 0.6, 0.7),
      mkProposal("prediction", 0.5, 0.8),
      mkProposal("planning", 0.4, 0.9),
    ];
    const a = resolve(bids);
    const b = resolve(bids);
    expect([...a.weights.entries()]).toEqual([...b.weights.entries()]);
    expect(a.ranked.map((p) => p.faculty)).toEqual(b.ranked.map((p) => p.faculty));
  });

  it("ties are broken by FACULTY_IDS order (stable)", () => {
    // Identical bids — only faculty differs. The one earlier in FACULTY_IDS wins.
    const memBid = mkProposal("memory", 0.5, 0.5);
    const idBid = mkProposal("identity", 0.5, 0.5);
    // memory < identity in FACULTY_IDS order.
    const r = resolve([idBid, memBid]); // swap input order on purpose
    expect(r.winner?.faculty).toBe("memory");
  });

  it("weights sum to 1.0 across many proposals", () => {
    const bids: Proposal[] = FACULTY_IDS.map((f, i) =>
      mkProposal(f, 0.1 + i * 0.1, 0.2 + i * 0.05),
    );
    const r = resolve(bids);
    let total = 0;
    for (const w of r.weights.values()) total += w;
    expect(total).toBeCloseTo(1, 6);
  });

  it("low temperature is more decisive (winner mass higher) than high temperature", () => {
    const bids = [
      mkProposal("memory", 0.4, 0.5),
      mkProposal("prediction", 0.8, 0.8),
    ];
    const decisive = resolve(bids, { temperature: 0.1 });
    const diffuse = resolve(bids, { temperature: 5 });
    const decisiveWin = decisive.weights.get(decisive.winner!.faculty)!;
    const diffuseWin = diffuse.weights.get(diffuse.winner!.faculty)!;
    expect(decisiveWin).toBeGreaterThan(diffuseWin);
  });

  it("clamps out-of-range bid components without throwing", () => {
    // Out-of-band values should be treated as if clamped to [0,1] (so this
    // bid behaves like a clamped one — not throwing, not NaN-poisoning).
    const wild = mkProposal("memory", 2.5, -0.3, 99, -42);
    const sane = mkProposal("prediction", 0.5, 0.5);
    const r = resolve([wild, sane]);
    expect(r.winner).not.toBeNull();
    // Winner is well-defined and weights sum to 1 even with the wild input.
    let total = 0;
    for (const w of r.weights.values()) total += w;
    expect(total).toBeCloseTo(1, 6);
  });
});

describe("ProposalArbiter (bus integration)", () => {
  it("emits proposal:winner exactly once per tick with bids in-window", () => {
    const bus = new BrainEventBus();
    let nowVal = 1000;
    const arb = new ProposalArbiter(bus, {
      tickMs: 100,
      windowMs: 200,
      now: () => nowVal,
    });
    const winners: Array<string | null> = [];
    bus.on("proposal:winner", (r) => winners.push(r.winner?.faculty ?? null));

    // Feed three bids inside the window, manually tick.
    arb.start();
    bus.emit("proposal:bid", mkProposal("memory", 0.3, 0.5, 0.5, 0, nowVal));
    bus.emit("proposal:bid", mkProposal("planning", 0.9, 0.9, 0.5, 0, nowVal));
    bus.emit("proposal:bid", mkProposal("prediction", 0.6, 0.6, 0.5, 0, nowVal));
    expect(arb.bufferSize).toBe(3);

    arb.tick();
    expect(winners).toEqual(["planning"]);
    expect(arb.bufferSize).toBe(0); // buffer drained after tick
    arb.stop();
  });

  it("drops stale bids beyond the window", () => {
    const bus = new BrainEventBus();
    let nowVal = 1000;
    const arb = new ProposalArbiter(bus, {
      tickMs: 100,
      windowMs: 200,
      now: () => nowVal,
    });
    const winners: Array<string | null> = [];
    bus.on("proposal:winner", (r) => winners.push(r.winner?.faculty ?? null));

    arb.start();
    bus.emit("proposal:bid", mkProposal("memory", 0.9, 0.9, 0.5, 0, nowVal)); // fresh
    nowVal += 300; // jump clock past windowMs
    bus.emit("proposal:bid", mkProposal("planning", 0.2, 0.2, 0.5, 0, nowVal)); // also fresh @ new now
    // Both bids are in `buffered`, but only the planning one is still in the
    // rolling window from `nowVal`. The memory bid is stale (at=1000, cutoff=1100).
    arb.tick();
    expect(winners).toEqual(["planning"]);
    arb.stop();
  });

  it("emits nothing on a tick with no in-window bids", () => {
    const bus = new BrainEventBus();
    const arb = new ProposalArbiter(bus, { tickMs: 100, windowMs: 200, now: () => 1000 });
    let calls = 0;
    bus.on("proposal:winner", () => (calls += 1));
    arb.start();
    arb.tick();
    expect(calls).toBe(0);
    arb.stop();
  });

  it("stop() unsubscribes — later bids are not buffered", () => {
    const bus = new BrainEventBus();
    let nowVal = 1000;
    const arb = new ProposalArbiter(bus, { tickMs: 100, windowMs: 200, now: () => nowVal });
    arb.start();
    arb.stop();
    bus.emit("proposal:bid", mkProposal("memory", 0.5, 0.5, 0.5, 0, nowVal));
    expect(arb.bufferSize).toBe(0);
  });

  it("start() is idempotent — calling twice does not double-subscribe", () => {
    const bus = new BrainEventBus();
    let nowVal = 1000;
    const arb = new ProposalArbiter(bus, { tickMs: 100, windowMs: 200, now: () => nowVal });
    arb.start();
    arb.start();
    bus.emit("proposal:bid", mkProposal("memory", 0.5, 0.5, 0.5, 0, nowVal));
    expect(arb.bufferSize).toBe(1); // would be 2 if double-subscribed
    arb.stop();
  });
});
