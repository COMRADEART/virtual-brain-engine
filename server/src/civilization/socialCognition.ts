import { ulid } from "ulid";
import type {
  BrainDescriptor,
  BrainPeer,
  BrainRelationship,
  BrainRole,
  InterBrainMessage,
  RelationshipType,
  SocialModel,
  PeerBrainModel,
  SocialNorm,
  TrustScore,
  TrustEvidence,
} from "../../../shared/civilization.js";

export interface SocialCognitionConfig {
  trustDecayRate: number;
  minTrustThreshold: number;
  maxTrustPerInteraction: number;
  competenceWeight: number;
  reliabilityWeight: number;
  safetyWeight: number;
  honestyWeight: number;
  updateIntervalMs: number;
  relationshipDriftRate: number;
}

const DEFAULT_CONFIG: SocialCognitionConfig = {
  trustDecayRate: 0.02,
  minTrustThreshold: 0.1,
  maxTrustPerInteraction: 0.1,
  competenceWeight: 0.3,
  reliabilityWeight: 0.3,
  safetyWeight: 0.25,
  honestyWeight: 0.15,
  updateIntervalMs: 60000,
  relationshipDriftRate: 0.01,
};

export interface InteractionRecord {
  id: string;
  type: "collaboration" | "trade" | "governance" | "conflict" | "exchange" | "information";
  outcome: "success" | "partial" | "failure";
  trustDelta: number;
  context: string;
  taskId?: string;
  timestamp: string;
  peerId: string;
}

export interface IntentionModel {
  peerId: string;
  perceivedGoals: string[];
  perceivedIntent: "friendly" | "neutral" | "hostile" | "unknown";
  cooperationProbability: number;
  conflictProbability: number;
  lastUpdatedAt: string;
}

export class SocialCognitionEngine {
  private readonly config: SocialCognitionConfig;
  private readonly relationships = new Map<string, BrainRelationship>();
  private readonly peerModels = new Map<string, PeerBrainModel>();
  private readonly intentions = new Map<string, IntentionModel>();
  private readonly socialNorms: SocialNorm[] = [];
  private readonly interactionHistory: InteractionRecord[] = [];
  private readonly trustEvidence: TrustEvidence[] = [];
  private myRole: BrainRole = "generalist";
  private readonly blockedPeers = new Set<string>();
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SocialCognitionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    this.updateTimer = setInterval(() => {
      this.applyTemporalDecay();
      this.updateIntentions();
    }, this.config.updateIntervalMs);
    this.updateTimer.unref?.();
  }

  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  setMyRole(role: BrainRole): void {
    this.myRole = role;
  }

  getMyRole(): BrainRole {
    return this.myRole;
  }

  recordInteraction(
    peerId: string,
    type: InteractionRecord["type"],
    outcome: InteractionRecord["outcome"],
    context: string,
    taskId?: string,
  ): void {
    const now = new Date().toISOString();

    const trustDelta = this.calculateTrustDelta(outcome, type);

    const record: InteractionRecord = {
      id: ulid(),
      type,
      outcome,
      trustDelta,
      context,
      taskId,
      timestamp: now,
      peerId,
    };

    this.interactionHistory.push(record);
    if (this.interactionHistory.length > 10000) {
      this.interactionHistory.shift();
    }

    let relationship = this.relationships.get(peerId);
    if (!relationship) {
      relationship = this.createInitialRelationship(peerId);
      this.relationships.set(peerId, relationship);
    }

    relationship.totalInteractions++;
    if (outcome === "success") {
      relationship.successfulCollaborations++;
    } else if (outcome === "failure") {
      relationship.failedInteractions++;
    }

    const oldTrust = relationship.trust;
    relationship.trust = Math.max(0, Math.min(1, relationship.trust + trustDelta));
    relationship.lastInteractionAt = now;

    if (type === "collaboration" || type === "trade") {
      relationship.reliability = this.calculateReliability(peerId);
    }

    if (type === "governance" || type === "information") {
      const currentModel = this.peerModels.get(peerId);
      if (currentModel) {
        currentModel.perceivedReliability = relationship.reliability;
      }
    }

    const evidence: TrustEvidence = {
      id: ulid(),
      fromBrainId: "self",
      aboutBrainId: peerId,
      trustAxis: this.inferTrustAxis(type),
      delta: trustDelta,
      context,
      taskId,
      timestamp: now,
    };
    this.trustEvidence.push(evidence);

    this.updateIntentModel(peerId, outcome, type);

    this.updateRelationshipType(peerId);
  }

  getRelationship(peerId: string): BrainRelationship | undefined {
    return this.relationships.get(peerId);
  }

  getAllRelationships(): BrainRelationship[] {
    return Array.from(this.relationships.values());
  }

  getPeerModel(peerId: string): PeerBrainModel | undefined {
    return this.peerModels.get(peerId);
  }

  getTrustScore(peerId: string): TrustScore | undefined {
    const relationship = this.relationships.get(peerId);
    if (!relationship) return undefined;

    const evidence = this.trustEvidence.filter((e) => e.aboutBrainId === peerId);
    const competenceEvidence = evidence.filter((e) => e.trustAxis === "competence");
    const reliabilityEvidence = evidence.filter((e) => e.trustAxis === "reliability");
    const safetyEvidence = evidence.filter((e) => e.trustAxis === "safety");
    const honestyEvidence = evidence.filter((e) => e.trustAxis === "honesty");

    return {
      brainId: peerId,
      overallTrust: relationship.trust,
      competenceTrust: this.aggregateAxisEvidence(competenceEvidence, this.config.competenceWeight),
      reliabilityTrust: this.aggregateAxisEvidence(reliabilityEvidence, this.config.reliabilityWeight),
      safetyTrust: this.aggregateAxisEvidence(safetyEvidence, this.config.safetyWeight),
      honestyTrust: this.aggregateAxisEvidence(honestyEvidence, this.config.honestyWeight),
      temporalDecayFactor: this.calculateTemporalDecay(peerId),
      lastUpdatedAt: relationship.lastInteractionAt,
      evidenceCount: evidence.length,
    };
  }

  getIntentionModel(peerId: string): IntentionModel | undefined {
    return this.intentions.get(peerId);
  }

  getSocialModel(): SocialModel {
    return {
      myRole: this.myRole,
      peerModels: this.peerModels,
      groupMemberships: new Map(),
      socialNorms: this.socialNorms,
      blockedPeers: this.blockedPeers,
    };
  }

  blockPeer(peerId: string, reason: string): void {
    this.blockedPeers.add(peerId);
    const relationship = this.relationships.get(peerId);
    if (relationship) {
      relationship.trust = Math.min(relationship.trust, this.config.minTrustThreshold);
      relationship.notes.push(`Blocked: ${reason} at ${new Date().toISOString()}`);
    }
  }

  unblockPeer(peerId: string): void {
    this.blockedPeers.delete(peerId);
  }

  isBlocked(peerId: string): boolean {
    return this.blockedPeers.has(peerId);
  }

  addSocialNorm(description: string, agreedBy: string[], enforcementLevel: SocialNorm["enforcementLevel"] = "soft"): SocialNorm {
    const norm: SocialNorm = {
      id: ulid(),
      description,
      agreedBy,
      createdAt: new Date().toISOString(),
      enforcementLevel,
    };
    this.socialNorms.push(norm);
    return norm;
  }

  agreeToNorm(normId: string, brainId: string): void {
    const norm = this.socialNorms.find((n) => n.id === normId);
    if (norm && !norm.agreedBy.includes(brainId)) {
      norm.agreedBy.push(brainId);
    }
  }

  getSocialNorms(): SocialNorm[] {
    return [...this.socialNorms];
  }

  updateFromPeerMessage(peerId: string, message: InterBrainMessage): void {
    let model = this.peerModels.get(peerId);
    if (!model) {
      model = this.createInitialPeerModel(peerId);
      this.peerModels.set(peerId, model);
    }

    model.lastConversationAt = message.timestamp;

    switch (message.type) {
      case "task-delegate":
        model.perceivedCapabilities.push("task-delegation");
        break;
      case "memory-share":
        model.perceivedCapabilities.push("memory-sharing");
        break;
      case "vote":
        model.perceivedCapabilities.push("governance-participation");
        break;
      case "goal-propose":
        model.perceivedCapabilities.push("leadership");
        break;
      case "consensus-request":
        model.perceivedCapabilities.push("reasoning");
        break;
    }

    if (message.type === "consensus-response") {
      const payload = message.payload as { confidence?: number };
      if (payload.confidence !== undefined) {
        const currentModel = this.intentions.get(peerId);
        if (currentModel) {
          currentModel.cooperationProbability = Math.max(0, Math.min(1,
            currentModel.cooperationProbability * 0.9 + payload.confidence * 0.1
          ));
        }
      }
    }
  }

  predictCooperation(peerId: string, taskType: string): number {
    const relationship = this.relationships.get(peerId);
    const model = this.peerModels.get(peerId);
    const intention = this.intentions.get(peerId);

    if (!relationship || !model) return 0.5;

    let score = relationship.trust * 0.4;
    score += relationship.reliability * 0.2;
    score += model.cooperationLikelihood * 0.2;

    if (intention) {
      if (intention.perceivedIntent === "friendly") score += 0.15;
      else if (intention.perceivedIntent === "hostile") score -= 0.2;
      score += intention.cooperationProbability * 0.1;
    }

    if (this.hasRelevantExperience(peerId, taskType)) {
      score += 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  getCooperationHistory(peerId: string): InteractionRecord[] {
    return this.interactionHistory.filter(
      (r) => r.peerId === peerId && (r.type === "collaboration" || r.type === "trade"),
    );
  }

  getConflictHistory(peerId: string): InteractionRecord[] {
    return this.interactionHistory.filter(
      (r) => r.peerId === peerId && r.type === "conflict",
    );
  }

  private createInitialRelationship(peerId: string): BrainRelationship {
    return {
      peerId,
      relationshipType: "unknown",
      trust: 0.5,
      reliability: 0.5,
      competence: 0.5,
      safetyScore: 0.7,
      sharedGoals: [],
      totalInteractions: 0,
      successfulCollaborations: 0,
      failedInteractions: 0,
      lastInteractionAt: new Date().toISOString(),
      firstInteractionAt: new Date().toISOString(),
      notes: [],
    };
  }

  private createInitialPeerModel(peerId: string): PeerBrainModel {
    return {
      peerId,
      perceivedCapabilities: [],
      perceivedReliability: 0.5,
      perceivedIntent: "unknown",
      cooperationLikelihood: 0.5,
      specializationStrengths: [],
      preferredCommunicationStyle: "formal",
    };
  }

  private calculateTrustDelta(outcome: InteractionRecord["outcome"], type: InteractionRecord["type"]): number {
    const baseDelta = outcome === "success" ? 0.05 : outcome === "partial" ? 0 : -0.08;

    const typeMultiplier = type === "collaboration" ? 1.2 : type === "trade" ? 1.0 : type === "governance" ? 0.8 : 0.6;

    const sign = baseDelta >= 0 ? 1 : -1;
    const magnitude = Math.min(Math.abs(baseDelta), this.config.maxTrustPerInteraction);

    return sign * magnitude * typeMultiplier;
  }

  private calculateReliability(peerId: string): number {
    const records = this.interactionHistory.filter(
      (r) => r.peerId === peerId && (r.type === "collaboration" || r.type === "trade"),
    );

    if (records.length === 0) return 0.5;

    const successCount = records.filter((r) => r.outcome === "success").length;
    return successCount / records.length;
  }

  private aggregateAxisEvidence(evidence: TrustEvidence[], weight: number): number {
    if (evidence.length === 0) return 0.5;

    const weightedSum = evidence.reduce((sum, e) => sum + e.delta * weight, 0);
    return Math.max(0, Math.min(1, 0.5 + weightedSum));
  }

  private calculateTemporalDecay(peerId: string): number {
    const relationship = this.relationships.get(peerId);
    if (!relationship) return 1;

    const lastInteraction = new Date(relationship.lastInteractionAt).getTime();
    const daysSince = (Date.now() - lastInteraction) / (1000 * 60 * 60 * 24);

    return Math.pow(1 - this.config.trustDecayRate, daysSince);
  }

  private applyTemporalDecay(): void {
    const now = Date.now();

    for (const relationship of this.relationships.values()) {
      const lastInteraction = new Date(relationship.lastInteractionAt).getTime();
      const daysSince = (now - lastInteraction) / (1000 * 60 * 60 * 24);

      if (daysSince > 1) {
        const decay = Math.pow(1 - this.config.trustDecayRate, daysSince);
        relationship.trust *= decay;
      }
    }
  }

  private updateIntentModel(peerId: string, outcome: InteractionRecord["outcome"], type: InteractionRecord["type"]): void {
    let intention = this.intentions.get(peerId);
    if (!intention) {
      intention = {
        peerId,
        perceivedGoals: [],
        perceivedIntent: "unknown",
        cooperationProbability: 0.5,
        conflictProbability: 0.3,
        lastUpdatedAt: new Date().toISOString(),
      };
      this.intentions.set(peerId, intention);
    }

    if (type === "collaboration" || type === "trade") {
      if (outcome === "success") {
        intention.cooperationProbability = Math.min(1, intention.cooperationProbability + 0.05);
        intention.conflictProbability = Math.max(0, intention.conflictProbability - 0.02);
        if (intention.perceivedIntent === "unknown" || intention.perceivedIntent === "neutral") {
          intention.perceivedIntent = "friendly";
        }
      } else if (outcome === "failure") {
        intention.conflictProbability = Math.min(1, intention.conflictProbability + 0.08);
        intention.cooperationProbability = Math.max(0, intention.cooperationProbability - 0.05);
        if (intention.perceivedIntent === "friendly") {
          intention.perceivedIntent = "neutral";
        }
      }
    } else if (type === "conflict") {
      intention.conflictProbability = Math.min(1, intention.conflictProbability + 0.15);
      intention.cooperationProbability = Math.max(0, intention.cooperationProbability - 0.1);
      intention.perceivedIntent = "hostile";
    }

    intention.lastUpdatedAt = new Date().toISOString();
  }

  private updateIntentions(): void {
    for (const intention of this.intentions.values()) {
      const drift = this.config.relationshipDriftRate;
      intention.cooperationProbability = Math.max(0, Math.min(1,
        intention.cooperationProbability + (Math.random() - 0.5) * drift
      ));
      intention.conflictProbability = Math.max(0, Math.min(1,
        intention.conflictProbability + (Math.random() - 0.5) * drift
      ));
    }
  }

  private updateRelationshipType(peerId: string): void {
    const relationship = this.relationships.get(peerId);
    const intention = this.intentions.get(peerId);

    if (!relationship) return;

    if (relationship.trust < this.config.minTrustThreshold) {
      relationship.relationshipType = "competitor";
    } else if (intention?.perceivedIntent === "hostile") {
      relationship.relationshipType = "competitor";
    } else if (relationship.trust > 0.7 && (intention?.perceivedIntent === "friendly")) {
      relationship.relationshipType = "ally";
    } else if (relationship.totalInteractions > 3) {
      relationship.relationshipType = "neutral";
    }
  }

  private inferTrustAxis(type: InteractionRecord["type"]): TrustEvidence["trustAxis"] {
    switch (type) {
      case "collaboration":
      case "exchange":
        return "competence";
      case "trade":
        return "reliability";
      case "governance":
        return "honesty";
      case "conflict":
        return "safety";
      default:
        return "reliability";
    }
  }

  private hasRelevantExperience(peerId: string, taskType: string): boolean {
    return this.interactionHistory.some(
      (r) => r.peerId === peerId && r.context.includes(taskType) && r.outcome === "success",
    );
  }
}

let singleton: SocialCognitionEngine | null = null;

export function createSocialCognition(config?: Partial<SocialCognitionConfig>): SocialCognitionEngine {
  if (!singleton) {
    singleton = new SocialCognitionEngine(config);
  }
  return singleton;
}

export function getSocialCognition(): SocialCognitionEngine | null {
  return singleton;
}