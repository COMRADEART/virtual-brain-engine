import { ulid } from "ulid";
import type {
  InterBrainMessage,
  TrustScore,
  TrustEvidence,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

/**
 * Trust & Reputation System (architecture component #4).
 *
 * Distinct from socialCognition, which models trust from the LOCAL brain's own
 * first-hand interactions. This layer aggregates a *network-wide reputation*:
 * it fuses self-evidence with THIRD-PARTY reports received from peers, weighting
 * each reporter by that reporter's own standing (Sybil resistance) and decaying
 * stale evidence toward a neutral baseline. The two cooperate — socialCognition
 * feeds first-hand evidence in via `setSelfTrustProvider`, and this engine answers
 * `trust-query` messages with a propagated, collusion-resistant reputation.
 */

export type TrustAxis = TrustEvidence["trustAxis"];

export interface TrustReputationConfig {
  /** Per-day pull of stale evidence back toward the neutral baseline (0..1). */
  temporalDecayRate: number;
  /** Multiplier applied to the local brain's own first-hand evidence. */
  selfReporterWeight: number;
  /** Floor weight for reports from unknown / low-standing reporters. */
  minReporterWeight: number;
  /** Evidence count a reporter needs before their reports count at full weight. */
  sybilEvidenceThreshold: number;
  /** How strongly a single remote report can move a target's reputation. */
  propagationDamping: number;
  neutralBaseline: number;
  axisWeights: { competence: number; reliability: number; safety: number; honesty: number };
  updateIntervalMs: number;
}

const DEFAULT_CONFIG: TrustReputationConfig = {
  temporalDecayRate: 0.01,
  selfReporterWeight: 2.0,
  minReporterWeight: 0.1,
  sybilEvidenceThreshold: 3,
  propagationDamping: 0.25,
  neutralBaseline: 0.5,
  axisWeights: { competence: 0.3, reliability: 0.3, safety: 0.25, honesty: 0.15 },
  updateIntervalMs: 60000,
};

export interface SybilSignal {
  reporterId: string;
  reason: "low-standing-high-volume" | "identical-reports" | "burst";
  evidenceCount: number;
  reporterReputation: number;
  detectedAt: string;
}

export interface TrustReputationEventHandlers {
  onReputationChanged?: (brainId: string, oldTrust: number, newTrust: number) => void;
  onSybilDetected?: (signal: SybilSignal) => void;
}

const SELF = "self";

export class TrustReputationSystem {
  private readonly config: TrustReputationConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: TrustReputationEventHandlers;
  /** All evidence, keyed by the brain it is ABOUT. */
  private readonly evidence = new Map<string, TrustEvidence[]>();
  /** Cached overall trust per brain, used for reporter weighting + change events. */
  private readonly cachedTrust = new Map<string, number>();
  private myBrainId = SELF;
  private selfTrustProvider: ((brainId: string) => number) | null = null;
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    network: BrainNetwork,
    config: Partial<TrustReputationConfig> = {},
    handlers: TrustReputationEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  /** Bridge to socialCognition so a reporter's *own* standing is available locally. */
  setSelfTrustProvider(provider: (brainId: string) => number): void {
    this.selfTrustProvider = provider;
  }

  start(): void {
    this.updateTimer = setInterval(() => this.applyDecay(), this.config.updateIntervalMs);
    this.updateTimer.unref?.();
  }

  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  /** Record a piece of trust evidence (first-hand if `fromBrainId === self`). */
  recordEvidence(
    fromBrainId: string,
    aboutBrainId: string,
    trustAxis: TrustAxis,
    delta: number,
    context: string,
    taskId?: string,
  ): TrustEvidence {
    const record: TrustEvidence = {
      id: ulid(),
      fromBrainId,
      aboutBrainId,
      trustAxis,
      delta: Math.max(-1, Math.min(1, delta)),
      context,
      taskId,
      timestamp: new Date().toISOString(),
    };

    const list = this.evidence.get(aboutBrainId) ?? [];
    list.push(record);
    if (list.length > 5000) list.shift();
    this.evidence.set(aboutBrainId, list);

    this.recompute(aboutBrainId);
    return record;
  }

  /** Handle an incoming `trust-update` / `trust-response` from a peer. */
  ingestRemoteReport(peerId: string, message: InterBrainMessage): void {
    if (message.type !== "trust-update" && message.type !== "trust-response") return;
    const payload = message.payload as {
      aboutBrainId?: string;
      trustAxis?: TrustAxis;
      delta?: number;
      context?: string;
    };
    if (!payload.aboutBrainId || payload.delta === undefined) return;
    // A remote report is third-party evidence — damped so one peer can't dominate.
    this.recordEvidence(
      peerId,
      payload.aboutBrainId,
      payload.trustAxis ?? "reliability",
      payload.delta * this.config.propagationDamping,
      payload.context ?? `propagated via ${peerId}`,
    );
    this.flagSybil(peerId);
  }

  /** Ask the network for peers' opinions of a brain. */
  requestReputation(aboutBrainId: string): void {
    this.network.broadcast({
      id: ulid(),
      type: "trust-query",
      sourceBrainId: this.myBrainId,
      payload: { aboutBrainId },
      timestamp: new Date().toISOString(),
    });
  }

  /** Answer a peer's `trust-query` with our computed reputation for the subject. */
  shareReputation(aboutBrainId: string, targetPeerId?: string): void {
    const score = this.getReputation(aboutBrainId);
    const message: InterBrainMessage = {
      id: ulid(),
      type: "trust-response",
      sourceBrainId: this.myBrainId,
      targetBrainId: targetPeerId,
      payload: {
        aboutBrainId,
        trustAxis: "reliability" as TrustAxis,
        delta: score.overallTrust - this.config.neutralBaseline,
        context: `reputation digest (${score.evidenceCount} signals)`,
      },
      timestamp: new Date().toISOString(),
    };
    if (targetPeerId) this.network.send(targetPeerId, message);
    else this.network.broadcast(message);
  }

  getReputation(brainId: string): TrustScore {
    const evidence = this.evidence.get(brainId) ?? [];
    const competence = this.aggregateAxis(brainId, evidence, "competence");
    const reliability = this.aggregateAxis(brainId, evidence, "reliability");
    const safety = this.aggregateAxis(brainId, evidence, "safety");
    const honesty = this.aggregateAxis(brainId, evidence, "honesty");

    const w = this.config.axisWeights;
    const overall = clamp01(
      competence * w.competence +
        reliability * w.reliability +
        safety * w.safety +
        honesty * w.honesty,
    );

    return {
      brainId,
      overallTrust: overall,
      competenceTrust: competence,
      reliabilityTrust: reliability,
      safetyTrust: safety,
      honestyTrust: honesty,
      temporalDecayFactor: this.latestDecayFactor(evidence),
      lastUpdatedAt: evidence.at(-1)?.timestamp ?? new Date().toISOString(),
      evidenceCount: evidence.length,
    };
  }

  getGlobalTrust(brainId: string): number {
    return this.cachedTrust.get(brainId) ?? this.config.neutralBaseline;
  }

  getAllReputations(): TrustScore[] {
    return Array.from(this.evidence.keys()).map((id) => this.getReputation(id));
  }

  /**
   * Sybil resistance: how much a reporter's claims count. Anchored to the
   * reporter's OWN standing and tempered by how much they've actually
   * participated, so a swarm of fresh low-standing identities can't brigade.
   */
  reporterWeight(reporterId: string): number {
    if (reporterId === SELF || reporterId === this.myBrainId) {
      return this.config.selfReporterWeight;
    }
    // Standing is the MOST CONSERVATIVE of two signals (Sybil resistance): the
    // local first-hand view (socialCognition, when wired) AND this engine's own
    // aggregated reputation of the reporter. Taking the min means a reporter we
    // have tanked here cannot be rescued by socialCognition's "never met → 0.5"
    // default — without it, the wired provider would silently disable detection
    // for the unknown-peer Sybils this is meant to catch.
    const providerStanding = this.selfTrustProvider ? this.selfTrustProvider(reporterId) : this.config.neutralBaseline;
    const cachedStanding = this.cachedTrust.get(reporterId) ?? this.config.neutralBaseline;
    const standing = Math.min(providerStanding, cachedStanding);
    const contributed = this.evidenceFrom(reporterId);
    const participation = Math.min(1, contributed / this.config.sybilEvidenceThreshold);
    return Math.max(this.config.minReporterWeight, standing * participation);
  }

  detectSybils(): SybilSignal[] {
    const byReporter = new Map<string, number>();
    for (const list of this.evidence.values()) {
      for (const e of list) {
        if (e.fromBrainId === SELF || e.fromBrainId === this.myBrainId) continue;
        byReporter.set(e.fromBrainId, (byReporter.get(e.fromBrainId) ?? 0) + 1);
      }
    }
    const signals: SybilSignal[] = [];
    for (const [reporterId, count] of byReporter) {
      const standing = this.reporterWeight(reporterId);
      if (count >= this.config.sybilEvidenceThreshold && standing <= this.config.minReporterWeight) {
        signals.push({
          reporterId,
          reason: "low-standing-high-volume",
          evidenceCount: count,
          reporterReputation: standing,
          detectedAt: new Date().toISOString(),
        });
      }
    }
    return signals;
  }

  private flagSybil(reporterId: string): void {
    const count = this.evidenceFrom(reporterId);
    if (count >= this.config.sybilEvidenceThreshold && this.reporterWeight(reporterId) <= this.config.minReporterWeight) {
      this.handlers.onSybilDetected?.({
        reporterId,
        reason: "low-standing-high-volume",
        evidenceCount: count,
        reporterReputation: this.reporterWeight(reporterId),
        detectedAt: new Date().toISOString(),
      });
    }
  }

  private evidenceFrom(reporterId: string): number {
    let n = 0;
    for (const list of this.evidence.values()) {
      for (const e of list) if (e.fromBrainId === reporterId) n++;
    }
    return n;
  }

  private aggregateAxis(_brainId: string, evidence: TrustEvidence[], axis: TrustAxis): number {
    const relevant = evidence.filter((e) => e.trustAxis === axis);
    if (relevant.length === 0) return this.config.neutralBaseline;

    let weightedDelta = 0;
    let totalWeight = 0;
    for (const e of relevant) {
      const decay = this.decayFactor(e.timestamp);
      const w = this.reporterWeight(e.fromBrainId) * decay;
      weightedDelta += e.delta * w;
      totalWeight += w;
    }
    if (totalWeight === 0) return this.config.neutralBaseline;
    return clamp01(this.config.neutralBaseline + weightedDelta / totalWeight);
  }

  private recompute(brainId: string): void {
    const oldTrust = this.cachedTrust.get(brainId) ?? this.config.neutralBaseline;
    const newTrust = this.getReputation(brainId).overallTrust;
    this.cachedTrust.set(brainId, newTrust);
    if (Math.abs(newTrust - oldTrust) > 1e-6) {
      this.handlers.onReputationChanged?.(brainId, oldTrust, newTrust);
    }
  }

  private decayFactor(timestamp: string): number {
    const days = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
    if (days <= 0) return 1;
    return Math.pow(1 - this.config.temporalDecayRate, days);
  }

  private latestDecayFactor(evidence: TrustEvidence[]): number {
    const latest = evidence.at(-1);
    return latest ? this.decayFactor(latest.timestamp) : 1;
  }

  private applyDecay(): void {
    for (const brainId of this.evidence.keys()) {
      this.recompute(brainId);
    }
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

let singleton: TrustReputationSystem | null = null;

export function createTrustReputation(
  network: BrainNetwork,
  config?: Partial<TrustReputationConfig>,
  handlers?: TrustReputationEventHandlers,
): TrustReputationSystem {
  if (!singleton) {
    singleton = new TrustReputationSystem(network, config, handlers);
  }
  return singleton;
}

export function getTrustReputation(): TrustReputationSystem | null {
  return singleton;
}
