import type {
  GovernanceModel,
  ResourceOffer,
  ResourceRequest,
} from "../../../shared/civilization.js";

/**
 * Civilization Simulation Engine (architecture component #16).
 *
 * Runs cheap forward simulations of governance, resource allocation, trust
 * evolution, and scaling BEFORE the civilization commits to a structure. Fully
 * deterministic given a seed (mulberry32), so results are reproducible and the
 * selfcheck can assert on exact outputs.
 */

export interface GovernanceSimInput {
  model: GovernanceModel;
  brainCount: number;
  /** Mean approval propensity of the population, 0..1. */
  approvalBias: number;
  proposals: number;
}

export interface GovernanceSimResult {
  model: GovernanceModel;
  passRate: number;
  avgDecisionRounds: number;
  fairness: number;
}

export interface ResourceSimResult {
  efficiency: number;
  unmetDemand: number;
  matchedAllocations: number;
}

export interface TrustSimResult {
  finalTrust: number;
  trajectory: number[];
  collapsed: boolean;
}

export interface ScalingSimResult {
  brainCount: number;
  messageOverhead: number;
  consensusLatencyMs: number;
  recommendation: "flat" | "hierarchical" | "federated";
}

export class CivilizationSimulationEngine {
  start(): void {
    // Stateless on-demand simulator; nothing to schedule.
  }

  stop(): void {
    // No resources held.
  }

  /** Simulate proposal throughput under a governance model. */
  simulateGovernance(input: GovernanceSimInput, seed = 1): GovernanceSimResult {
    const rng = mulberry32(seed);
    const quorum = this.quorumFor(input.model);
    let passed = 0;
    let totalRounds = 0;

    for (let i = 0; i < input.proposals; i++) {
      let support = 0;
      for (let b = 0; b < input.brainCount; b++) {
        if (rng() < input.approvalBias) support++;
      }
      const ratio = input.brainCount === 0 ? 0 : support / input.brainCount;
      // Consensus needs more rounds to converge; majority resolves fast.
      const rounds = input.model === "consensus" ? 3 : input.model === "weighted-expertise" ? 2 : 1;
      totalRounds += rounds;
      if (ratio >= quorum) passed++;
    }

    const passRate = input.proposals === 0 ? 0 : passed / input.proposals;
    // Fairness: how evenly votes translate to outcomes. Dictatorship is least fair.
    const fairness = input.model === "dictatorship" ? 0.2 : input.model === "consensus" ? 0.95 : 0.7;

    return {
      model: input.model,
      passRate,
      avgDecisionRounds: input.proposals === 0 ? 0 : totalRounds / input.proposals,
      fairness,
    };
  }

  /** Greedy market match of offers to requests, best price/urgency first. */
  simulateResourceAllocation(offers: ResourceOffer[], requests: ResourceRequest[]): ResourceSimResult {
    const remaining = new Map<string, number>();
    for (const o of offers) {
      remaining.set(o.id, o.amount);
    }
    const urgencyRank: Record<ResourceRequest["urgency"], number> = { critical: 3, high: 2, medium: 1, low: 0 };
    const sortedReq = [...requests].sort((a, b) => urgencyRank[b.urgency] - urgencyRank[a.urgency]);

    let matched = 0;
    let totalDemand = 0;
    let metDemand = 0;

    for (const req of sortedReq) {
      totalDemand += req.amount;
      let need = req.amount;
      const candidates = offers
        .filter((o) => o.resourceType === req.resourceType && (remaining.get(o.id) ?? 0) > 0)
        .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
      for (const o of candidates) {
        if (need <= 0) break;
        const avail = remaining.get(o.id) ?? 0;
        const take = Math.min(avail, need);
        if (take > 0) {
          remaining.set(o.id, avail - take);
          need -= take;
          metDemand += take;
          matched++;
        }
      }
    }

    return {
      efficiency: totalDemand === 0 ? 1 : metDemand / totalDemand,
      unmetDemand: Math.max(0, totalDemand - metDemand),
      matchedAllocations: matched,
    };
  }

  /** Iterate trust under repeated interactions with a given success rate. */
  simulateTrustEvolution(initialTrust: number, interactions: number, successRate: number, seed = 1): TrustSimResult {
    const rng = mulberry32(seed);
    let trust = clamp01(initialTrust);
    const trajectory: number[] = [trust];
    for (let i = 0; i < interactions; i++) {
      const success = rng() < successRate;
      trust = clamp01(trust + (success ? 0.05 : -0.08));
      trajectory.push(trust);
    }
    return { finalTrust: trust, trajectory, collapsed: trust <= 0.1 };
  }

  /** Estimate coordination cost at a given network size and recommend a topology. */
  simulateScaling(brainCount: number): ScalingSimResult {
    // All-to-all broadcast is O(n²); hierarchy O(n log n); federation O(n).
    const messageOverhead = brainCount * brainCount;
    const consensusLatencyMs = 20 * Math.log2(Math.max(2, brainCount)) * (brainCount > 50 ? 4 : 1);
    const recommendation: ScalingSimResult["recommendation"] =
      brainCount <= 8 ? "flat" : brainCount <= 64 ? "hierarchical" : "federated";
    return { brainCount, messageOverhead, consensusLatencyMs, recommendation };
  }

  private quorumFor(model: GovernanceModel): number {
    switch (model) {
      case "consensus":
        return 0.8;
      case "weighted-expertise":
        return 0.55;
      case "representative":
        return 0.5;
      case "direct-democracy":
        return 0.5;
      case "dictatorship":
        return 0.0;
    }
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

let singleton: CivilizationSimulationEngine | null = null;

export function createCivilizationSimulation(): CivilizationSimulationEngine {
  if (!singleton) {
    singleton = new CivilizationSimulationEngine();
  }
  return singleton;
}

export function getCivilizationSimulation(): CivilizationSimulationEngine | null {
  return singleton;
}
