import { ulid } from "ulid";
import type {
  BrainPeer,
  CultureType,
  CulturePractice,
  CultureEvolution,
  BrainRole,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

export interface CultureEngineConfig {
  evolutionRate: number;
  minSuccessRate: number;
  practiceAdoptionThreshold: number;
  culturalDriftRate: number;
  abstractionSharingIntervalMs: number;
}

const DEFAULT_CONFIG: CultureEngineConfig = {
  evolutionRate: 0.05,
  minSuccessRate: 0.6,
  practiceAdoptionThreshold: 0.7,
  culturalDriftRate: 0.02,
  abstractionSharingIntervalMs: 300000,
};

export interface CultureEventHandlers {
  onPracticeAdopted?: (practice: CulturePractice) => void;
  onCultureShift?: (from: CultureType, to: CultureType) => void;
  onAbstractionShared?: (abstraction: string, sharedBy: string[]) => void;
}

export class CultureEngine {
  private readonly config: CultureEngineConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: CultureEventHandlers;
  private readonly practices = new Map<string, CulturePractice>();
  private myCultureType: CultureType = "generalist";
  private myBrainId: string = "self";
  private evolutionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sharedAbstractions = new Map<string, string[]>();
  private readonly reasoningTraditions = new Map<string, string[]>();
  private readonly communicationPatterns = new Map<string, string[]>();

  constructor(
    network: BrainNetwork,
    config: Partial<CultureEngineConfig> = {},
    handlers: CultureEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;

    this.initializeDefaultPractices();
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  setMyCultureType(culture: CultureType): void {
    this.myCultureType = culture;
  }

  getMyCultureType(): CultureType {
    return this.myCultureType;
  }

  start(): void {
    this.evolutionTimer = setInterval(() => {
      this.evolveCulture();
    }, this.config.evolutionRate * 60000);
    this.evolutionTimer.unref?.();
  }

  stop(): void {
    if (this.evolutionTimer) {
      clearInterval(this.evolutionTimer);
      this.evolutionTimer = null;
    }
  }

  recordPracticeAttempt(practiceId: string, success: boolean, evidence?: string): void {
    const practice = this.practices.get(practiceId);
    if (!practice) return;

    practice.triedCount++;
    if (success) {
      const newSuccessRate = (practice.successRate * (practice.triedCount - 1) + 1) / practice.triedCount;
      practice.successRate = newSuccessRate;
      if (evidence && !practice.evidenceIds.includes(evidence)) {
        practice.evidenceIds.push(evidence);
      }
    } else {
      const newSuccessRate = practice.successRate * (practice.triedCount - 1) / practice.triedCount;
      practice.successRate = newSuccessRate;
    }

    practice.lastAttemptAt = new Date().toISOString();

    if (practice.successRate >= this.config.practiceAdoptionThreshold &&
        !practice.adoptedBy.includes(this.myBrainId)) {
      this.adoptPractice(practiceId);
    }
  }

  adoptPractice(practiceId: string): void {
    const practice = this.practices.get(practiceId);
    if (!practice) return;

    if (!practice.adoptedBy.includes(this.myBrainId)) {
      practice.adoptedBy.push(this.myBrainId);
      this.handlers.onPracticeAdopted?.(practice);
      this.broadcastPractice(practice);
    }
  }

  shareAbstraction(abstraction: string, peers: string[]): void {
    if (!this.sharedAbstractions.has(abstraction)) {
      this.sharedAbstractions.set(abstraction, []);
    }
    const adopters = this.sharedAbstractions.get(abstraction)!;
    for (const peer of peers) {
      if (!adopters.includes(peer)) {
        adopters.push(peer);
      }
    }

    this.handlers.onAbstractionShared?.(abstraction, adopters);
  }

  discoverSharedAbstraction(abstraction: string): string[] {
    return this.sharedAbstractions.get(abstraction) ?? [];
  }

  addReasoningTradition(tradition: string, peers: string[]): void {
    if (!this.reasoningTraditions.has(tradition)) {
      this.reasoningTraditions.set(tradition, []);
    }
    const adopters = this.reasoningTraditions.get(tradition)!;
    for (const peer of peers) {
      if (!adopters.includes(peer)) {
        adopters.push(peer);
      }
    }
  }

  getReasoningTraditions(): Map<string, string[]> {
    return this.reasoningTraditions;
  }

  addCommunicationPattern(pattern: string, peers: string[]): void {
    if (!this.communicationPatterns.has(pattern)) {
      this.communicationPatterns.set(pattern, []);
    }
    const adopters = this.communicationPatterns.get(pattern)!;
    for (const peer of peers) {
      if (!adopters.includes(peer)) {
        adopters.push(peer);
      }
    }
  }

  getCommunicationPatterns(): Map<string, string[]> {
    return this.communicationPatterns;
  }

  getPractice(practiceId: string): CulturePractice | undefined {
    return this.practices.get(practiceId);
  }

  getAllPractices(): CulturePractice[] {
    return Array.from(this.practices.values());
  }

  getPracticesByCulture(cultureType: CultureType): CulturePractice[] {
    return Array.from(this.practices.values()).filter((p) => p.cultureType === cultureType);
  }

  getAdoptedPractices(): CulturePractice[] {
    return Array.from(this.practices.values()).filter((p) => p.adoptedBy.includes(this.myBrainId));
  }

  getCultureEvolution(): CultureEvolution {
    const practices = Array.from(this.practices.values());

    const cultureCounts = new Map<CultureType, number>();
    for (const practice of practices) {
      const count = cultureCounts.get(practice.cultureType) ?? 0;
      cultureCounts.set(practice.cultureType, count + 1);
    }

    let dominant: CultureType = "generalist";
    let maxCount = 0;
    for (const [culture, count] of cultureCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominant = culture;
      }
    }

    const minority = Array.from(cultureCounts.entries())
      .filter(([c]) => c !== dominant)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => c);

    return {
      civilizationId: "local",
      dominantCulture: dominant,
      minorityCultures: minority,
      sharedAbstractions: Array.from(this.sharedAbstractions.keys()),
      reasoningTraditions: Array.from(this.reasoningTraditions.keys()),
      communicationPatterns: Array.from(this.communicationPatterns.keys()),
      divergenceMetrics: this.calculateDivergenceMetrics(),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  handleIncomingPractice(practice: CulturePractice): void {
    const existing = this.practices.get(practice.id);
    if (existing) {
      for (const brainId of practice.adoptedBy) {
        if (!existing.adoptedBy.includes(brainId)) {
          existing.adoptedBy.push(brainId);
        }
      }
      if (practice.triedCount > existing.triedCount) {
        existing.triedCount = practice.triedCount;
        existing.successRate = practice.successRate;
        existing.lastAttemptAt = practice.lastAttemptAt;
      }
    } else {
      this.practices.set(practice.id, practice);
      if (practice.successRate >= this.config.practiceAdoptionThreshold) {
        this.adoptPractice(practice.id);
      }
    }
  }

  handleIncomingAbstraction(abstraction: string, sharedBy: string[]): void {
    if (!this.sharedAbstractions.has(abstraction)) {
      this.sharedAbstractions.set(abstraction, []);
    }
    const adopters = this.sharedAbstractions.get(abstraction)!;
    for (const brainId of sharedBy) {
      if (!adopters.includes(brainId)) {
        adopters.push(brainId);
      }
    }
  }

  createGuild(name: string, purpose: string, initialMembers: string[], cultureType: CultureType): string {
    const practice: CulturePractice = {
      id: `guild-${ulid()}`,
      name,
      description: purpose,
      cultureType,
      adoptedBy: initialMembers,
      successRate: 0.5,
      triedCount: 1,
      evidenceIds: [],
    };

    this.practices.set(practice.id, practice);
    return practice.id;
  }

  private initializeDefaultPractices(): void {
    const defaults: Omit<CulturePractice, "id" | "adoptedBy" | "successRate" | "triedCount" | "evidenceIds">[] = [
      {
        name: "Pair Programming",
        description: "Two brains collaborate on a single task, reviewing each other's work in real-time",
        cultureType: "safety-first",
      },
      {
        name: "Test-Driven Development",
        description: "Write tests before implementation to ensure correctness",
        cultureType: "safety-first",
      },
      {
        name: "Rapid Prototyping",
        description: "Quickly build and test multiple solutions to find the best approach",
        cultureType: "speed-optimized",
      },
      {
        name: "Deep Research Sessions",
        description: "Thorough investigation with extensive simulation before acting",
        cultureType: "deep-research",
      },
      {
        name: "Creative Brainstorming",
        description: "Generate many diverse ideas without immediate judgment",
        cultureType: "creative",
      },
      {
        name: "Ensemble Learning",
        description: "Multiple brains independently solve then vote on best approach",
        cultureType: "generalist",
      },
    ];

    for (const def of defaults) {
      const practice: CulturePractice = {
        id: `practice-${ulid()}`,
        ...def,
        adoptedBy: [],
        successRate: 0.5,
        triedCount: 0,
        lastAttemptAt: new Date().toISOString(),
        evidenceIds: [],
      };
      this.practices.set(practice.id, practice);
    }
  }

  private evolveCulture(): void {
    for (const practice of this.practices.values()) {
      if (practice.successRate >= this.config.minSuccessRate &&
          practice.adoptedBy.length >= 2) {
        this.evolvePractice(practice);
      }

      const drift = this.config.culturalDriftRate;
      practice.successRate = Math.max(0, Math.min(1,
        practice.successRate + (Math.random() - 0.5) * drift
      ));
    }

    this.detectCulturalShift();
  }

  private evolvePractice(practice: CulturePractice): void {
    const mutation = Math.random();

    if (mutation < 0.3) {
      if (practice.cultureType === "safety-first" && Math.random() < 0.5) {
        practice.description += " (with speed optimization)";
      }
    }
  }

  private detectCulturalShift(): void {
    const evolution = this.getCultureEvolution();

    if (evolution.dominantCulture !== this.myCultureType) {
      const shift = this.myCultureType;
      this.myCultureType = evolution.dominantCulture;
      this.handlers.onCultureShift?.(shift, evolution.dominantCulture);
    }
  }

  private calculateDivergenceMetrics(): Record<string, number> {
    const metrics: Record<string, number> = {};

    const allAdopters = new Set<string>();
    for (const practice of this.practices.values()) {
      for (const brainId of practice.adoptedBy) {
        allAdopters.add(brainId);
      }
    }

    const cohesionScores: number[] = [];
    for (const brainId of allAdopters) {
      let sameCultureCount = 0;
      let totalCount = 0;
      for (const practice of this.practices.values()) {
        if (practice.adoptedBy.includes(brainId)) {
          totalCount++;
          if (practice.cultureType === this.myCultureType) {
            sameCultureCount++;
          }
        }
      }
      if (totalCount > 0) {
        cohesionScores.push(sameCultureCount / totalCount);
      }
    }

    if (cohesionScores.length > 0) {
      const avgCohesion = cohesionScores.reduce((a, b) => a + b, 0) / cohesionScores.length;
      metrics["cohesion"] = avgCohesion;
    } else {
      metrics["cohesion"] = 0;
    }

    metrics["practiceCount"] = this.practices.size;
    metrics["abstractionCount"] = this.sharedAbstractions.size;
    metrics["traditionCount"] = this.reasoningTraditions.size;

    return metrics;
  }

  private broadcastPractice(practice: CulturePractice): void {
    const message = {
      id: ulid(),
      type: "culture-share" as const,
      sourceBrainId: this.myBrainId,
      payload: { practice },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }
}

let singleton: CultureEngine | null = null;

export function createCultureEngine(
  network: BrainNetwork,
  config?: Partial<CultureEngineConfig>,
  handlers?: CultureEventHandlers,
): CultureEngine {
  if (!singleton) {
    singleton = new CultureEngine(network, config, handlers);
  }
  return singleton;
}

export function getCultureEngine(): CultureEngine | null {
  return singleton;
}