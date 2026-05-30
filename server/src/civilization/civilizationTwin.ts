import type {
  CivilizationTwin,
  ResourceFlow,
  ResourceType,
  TrustEdge,
} from "../../../shared/civilization.js";

/**
 * Civilization Digital Twin (architecture component #15).
 *
 * Maintains a quantitative model of the whole civilization over time: brain count,
 * interaction volume, active goals, memory shared, cultural cohesion, governance
 * decisions, plus the live resource-flow ledger and trust graph. It reads the other
 * engines through a pluggable `TwinProviders` seam (so it's decoupled and the
 * selfcheck can drive it hermetically), records resource flows directly, and keeps
 * a rolling snapshot history for trend analysis and what-if seeding.
 */

export interface TwinProviders {
  brainCount: () => number;
  interactionCount: () => number;
  activeGoals: () => number;
  memorySharedCount: () => number;
  culturalCohesion: () => number;
  governanceDecisions: () => number;
  groupMemberships: () => number;
  trustEdges: () => TrustEdge[];
}

export interface CivilizationTwinConfig {
  civilizationId: string;
  snapshotIntervalMs: number;
  maxHistory: number;
  maxResourceFlows: number;
}

const DEFAULT_CONFIG: CivilizationTwinConfig = {
  civilizationId: "local",
  snapshotIntervalMs: 60000,
  maxHistory: 500,
  maxResourceFlows: 5000,
};

const ZERO_PROVIDERS: TwinProviders = {
  brainCount: () => 0,
  interactionCount: () => 0,
  activeGoals: () => 0,
  memorySharedCount: () => 0,
  culturalCohesion: () => 1,
  governanceDecisions: () => 0,
  groupMemberships: () => 0,
  trustEdges: () => [],
};

export class CivilizationTwinModel {
  private readonly config: CivilizationTwinConfig;
  private providers: TwinProviders = ZERO_PROVIDERS;
  private readonly resourceFlows: ResourceFlow[] = [];
  private readonly history: CivilizationTwin[] = [];
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<CivilizationTwinConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setProviders(providers: Partial<TwinProviders>): void {
    this.providers = { ...this.providers, ...providers };
  }

  start(): void {
    this.snapshotTimer = setInterval(() => this.captureSnapshot(), this.config.snapshotIntervalMs);
    this.snapshotTimer.unref?.();
  }

  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  recordResourceFlow(fromBrainId: string, toBrainId: string, resourceType: ResourceType, amount: number): ResourceFlow {
    const flow: ResourceFlow = {
      fromBrainId,
      toBrainId,
      resourceType,
      amount,
      timestamp: new Date().toISOString(),
    };
    this.resourceFlows.push(flow);
    if (this.resourceFlows.length > this.config.maxResourceFlows) this.resourceFlows.shift();
    return flow;
  }

  captureSnapshot(): CivilizationTwin {
    const twin: CivilizationTwin = {
      civilizationId: this.config.civilizationId,
      totalBrains: this.providers.brainCount(),
      totalInteractions: this.providers.interactionCount(),
      activeGoals: this.providers.activeGoals(),
      totalMemoryShared: this.providers.memorySharedCount(),
      culturalCohesion: clamp01(this.providers.culturalCohesion()),
      governanceDecisions: this.providers.governanceDecisions(),
      resourceFlows: this.recentFlows(50),
      trustNetwork: this.providers.trustEdges(),
      groupMemberships: this.providers.groupMemberships(),
      snapshotAt: new Date().toISOString(),
    };
    this.history.push(twin);
    if (this.history.length > this.config.maxHistory) this.history.shift();
    return twin;
  }

  getLatest(): CivilizationTwin {
    return this.history.at(-1) ?? this.captureSnapshot();
  }

  getHistory(): CivilizationTwin[] {
    return [...this.history];
  }

  getResourceFlows(): ResourceFlow[] {
    return [...this.resourceFlows];
  }

  /** Net resource balance per brain (received − given) across the ledger. */
  getResourceBalances(): Record<string, number> {
    const balances: Record<string, number> = {};
    for (const flow of this.resourceFlows) {
      balances[flow.fromBrainId] = (balances[flow.fromBrainId] ?? 0) - flow.amount;
      balances[flow.toBrainId] = (balances[flow.toBrainId] ?? 0) + flow.amount;
    }
    return balances;
  }

  /** Direction of cohesion: positive = converging, negative = drifting apart. */
  getCohesionTrend(): number {
    if (this.history.length < 2) return 0;
    const first = this.history[0].culturalCohesion;
    const last = this.history.at(-1)!.culturalCohesion;
    return last - first;
  }

  private recentFlows(n: number): ResourceFlow[] {
    return this.resourceFlows.slice(-n);
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

let singleton: CivilizationTwinModel | null = null;

export function createCivilizationTwin(config?: Partial<CivilizationTwinConfig>): CivilizationTwinModel {
  if (!singleton) {
    singleton = new CivilizationTwinModel(config);
  }
  return singleton;
}

export function getCivilizationTwin(): CivilizationTwinModel | null {
  return singleton;
}
