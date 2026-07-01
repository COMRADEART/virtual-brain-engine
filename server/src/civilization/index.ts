export { BrainNetwork, createBrainNetwork, getBrainNetwork, type BrainNetworkConfig, type NetworkEventHandlers } from "./brainNetwork.js";
export { PeerDiscovery, createPeerDiscovery, getPeerDiscovery, type PeerDiscoveryConfig, type BootstrapNode, type PeerFilter } from "./peerDiscovery.js";
export { SocialCognitionEngine, createSocialCognition, getSocialCognition, type SocialCognitionConfig, type InteractionRecord } from "./socialCognition.js";
export { CollectiveMemorySync, createCollectiveMemory, getCollectiveMemory, type CollectiveMemoryConfig, type MemorySyncEventHandlers } from "./collectiveMemory.js";
export { GovernanceSystem, createGovernance, getGovernance, type GovernanceConfig, type GovernanceEventHandlers, type DelegatedVote } from "./governance.js";
export { ResourceEconomy, createResourceEconomy, getResourceEconomy, type ResourceEconomyConfig, type ResourceMarketEventHandlers } from "./resourceEconomy.js";
export { CultureEngine, createCultureEngine, getCultureEngine, type CultureEngineConfig, type CultureEventHandlers } from "./cultureEngine.js";
export { RoleSpecialization, createRoleSpecialization, getRoleSpecialization, type RoleSpecializationConfig, type RoleEventHandlers } from "./roleSpecialization.js";
export { CollectiveGoalSystem, createCollectiveGoals, getCollectiveGoals, type CollectiveGoalsConfig, type GoalEventHandlers } from "./collectiveGoals.js";
export { CivilizationVisualization, createCivilizationVisualization, getCivilizationVisualization, type VisualizationConfig } from "./civilizationViz.js";
export { TrustReputationSystem, createTrustReputation, getTrustReputation, type TrustReputationConfig, type TrustReputationEventHandlers, type SybilSignal } from "./trustReputation.js";
export { InterBrainMemorySystem, createInterBrainMemory, getInterBrainMemory, type InterBrainMemoryConfig, type CollaborationStats } from "./interBrainMemory.js";
export { EmergentOrganization, createEmergentOrg, getEmergentOrg, type EmergentOrgConfig, type EmergentOrgEventHandlers, type GroupPhase } from "./emergentOrg.js";
export { CollectiveImagination, createCollectiveImagination, getCollectiveImagination, type CollectiveImaginationConfig, type CollectiveImaginationEventHandlers, type FusionResult } from "./collectiveImagination.js";
export { LanguageEvolutionSystem, createLanguageEvolution, getLanguageEvolution, type LanguageEvolutionConfig } from "./languageEvolution.js";
export { CivilizationTwinModel, createCivilizationTwin, getCivilizationTwin, type CivilizationTwinConfig, type TwinProviders } from "./civilizationTwin.js";
export { CivilizationSimulationEngine, createCivilizationSimulation, getCivilizationSimulation } from "./civilizationSimulation.js";
export { CollectiveDreaming, createCollectiveDreaming, getCollectiveDreaming, type CollectiveDreamingConfig, type CollectiveDreamingEventHandlers, type DreamCycle, type DreamFocus } from "./collectiveDreaming.js";
export { EthicsSafetySystem, createEthicsSafety, getEthicsSafety, type EthicsSafetyConfig, type EthicsSafetyEventHandlers, type DecisionEvaluation } from "./ethicsSafety.js";
export { MultiCivilizationSystem, createMultiCivilization, getMultiCivilization, type MultiCivilizationConfig, type MultiCivilizationEventHandlers, type KnowledgeExchange, type InterCivConflict } from "./multiCivilization.js";

import { BrainNetwork, createBrainNetwork, type BrainNetworkConfig, type NetworkEventHandlers } from "./brainNetwork.js";
import { PeerDiscovery, createPeerDiscovery, type PeerDiscoveryConfig } from "./peerDiscovery.js";
import { SocialCognitionEngine, createSocialCognition, type SocialCognitionConfig } from "./socialCognition.js";
import { CollectiveMemorySync, createCollectiveMemory, type CollectiveMemoryConfig, type MemorySyncEventHandlers } from "./collectiveMemory.js";
import { GovernanceSystem, createGovernance, type GovernanceConfig, type GovernanceEventHandlers } from "./governance.js";
import { ResourceEconomy, createResourceEconomy, type ResourceEconomyConfig, type ResourceMarketEventHandlers } from "./resourceEconomy.js";
import { CultureEngine, createCultureEngine, type CultureEngineConfig, type CultureEventHandlers } from "./cultureEngine.js";
import { RoleSpecialization, createRoleSpecialization, type RoleSpecializationConfig, type RoleEventHandlers } from "./roleSpecialization.js";
import { CollectiveGoalSystem, createCollectiveGoals, type CollectiveGoalsConfig, type GoalEventHandlers } from "./collectiveGoals.js";
import { CivilizationVisualization, createCivilizationVisualization, type VisualizationConfig } from "./civilizationViz.js";
import { TrustReputationSystem, createTrustReputation, type TrustReputationConfig, type TrustReputationEventHandlers } from "./trustReputation.js";
import { InterBrainMemorySystem, createInterBrainMemory, type InterBrainMemoryConfig } from "./interBrainMemory.js";
import { EmergentOrganization, createEmergentOrg, type EmergentOrgConfig, type EmergentOrgEventHandlers } from "./emergentOrg.js";
import { CollectiveImagination, createCollectiveImagination, type CollectiveImaginationConfig, type CollectiveImaginationEventHandlers } from "./collectiveImagination.js";
import { LanguageEvolutionSystem, createLanguageEvolution, type LanguageEvolutionConfig } from "./languageEvolution.js";
import { CivilizationTwinModel, createCivilizationTwin, type CivilizationTwinConfig } from "./civilizationTwin.js";
import { CivilizationSimulationEngine, createCivilizationSimulation } from "./civilizationSimulation.js";
import { CollectiveDreaming, createCollectiveDreaming, type CollectiveDreamingConfig, type CollectiveDreamingEventHandlers } from "./collectiveDreaming.js";
import { EthicsSafetySystem, createEthicsSafety, type EthicsSafetyConfig, type EthicsSafetyEventHandlers } from "./ethicsSafety.js";
import { MultiCivilizationSystem, createMultiCivilization, type MultiCivilizationConfig, type MultiCivilizationEventHandlers } from "./multiCivilization.js";
import type { BrainDescriptor as SharedBrainDescriptor } from "../../../shared/civilization.js";

export interface CivilizationConfig {
  brainNetwork: Partial<BrainNetworkConfig>;
  peerDiscovery: Partial<PeerDiscoveryConfig>;
  socialCognition: Partial<SocialCognitionConfig>;
  collectiveMemory: Partial<CollectiveMemoryConfig>;
  governance: Partial<GovernanceConfig>;
  resourceEconomy: Partial<ResourceEconomyConfig>;
  cultureEngine: Partial<CultureEngineConfig>;
  roleSpecialization: Partial<RoleSpecializationConfig>;
  collectiveGoals: Partial<CollectiveGoalsConfig>;
  visualization: Partial<VisualizationConfig>;
  trustReputation: Partial<TrustReputationConfig>;
  interBrainMemory: Partial<InterBrainMemoryConfig>;
  emergentOrg: Partial<EmergentOrgConfig>;
  collectiveImagination: Partial<CollectiveImaginationConfig>;
  languageEvolution: Partial<LanguageEvolutionConfig>;
  civilizationTwin: Partial<CivilizationTwinConfig>;
  collectiveDreaming: Partial<CollectiveDreamingConfig>;
  ethicsSafety: Partial<EthicsSafetyConfig>;
  multiCivilization: Partial<MultiCivilizationConfig>;
}

export interface CivilizationSystem {
  network: BrainNetwork;
  peerDiscovery: PeerDiscovery;
  socialCognition: SocialCognitionEngine;
  collectiveMemory: CollectiveMemorySync;
  governance: GovernanceSystem;
  resourceEconomy: ResourceEconomy;
  cultureEngine: CultureEngine;
  roleSpecialization: RoleSpecialization;
  collectiveGoals: CollectiveGoalSystem;
  visualization: CivilizationVisualization;
  trustReputation: TrustReputationSystem;
  interBrainMemory: InterBrainMemorySystem;
  emergentOrg: EmergentOrganization;
  collectiveImagination: CollectiveImagination;
  languageEvolution: LanguageEvolutionSystem;
  civilizationTwin: CivilizationTwinModel;
  simulation: CivilizationSimulationEngine;
  collectiveDreaming: CollectiveDreaming;
  ethicsSafety: EthicsSafetySystem;
  multiCivilization: MultiCivilizationSystem;
}

export type BrainDescriptor = SharedBrainDescriptor;

const DEFAULT_CIVILIZATION_CONFIG: CivilizationConfig = {
  brainNetwork: { port: 8788, maxPeers: 64, heartbeatIntervalMs: 5000, enableLogging: true },
  peerDiscovery: { enabled: true, broadcastIntervalMs: 10000, peerTimeoutMs: 60000, enableMdns: false, enableBroadcast: true, bootstrapNodes: [] },
  socialCognition: { trustDecayRate: 0.02, minTrustThreshold: 0.1, updateIntervalMs: 60000 },
  collectiveMemory: { syncIntervalMs: 120000, maxMemoryPerSync: 100, importanceThreshold: 0.3, enableSelectiveSync: true },
  governance: { defaultGovernanceModel: "consensus", voteTimeoutMs: 300000, quorumPercentage: 0.5, proposalDurationMs: 600000 },
  resourceEconomy: { settlementIntervalMs: 60000, enableBidirectional: true },
  cultureEngine: { evolutionRate: 0.05, practiceAdoptionThreshold: 0.7, culturalDriftRate: 0.02 },
  roleSpecialization: { evidenceThreshold: 3, guildFormationThreshold: 3, roleRotationPeriodMs: 3600000 },
  collectiveGoals: { decompositionDepthLimit: 5, progressReportIntervalMs: 3600000 },
  visualization: { updateIntervalMs: 5000, maxActivityEvents: 100, maxTopologyNodes: 200 },
  trustReputation: {},
  interBrainMemory: {},
  emergentOrg: {},
  collectiveImagination: {},
  languageEvolution: {},
  civilizationTwin: {},
  collectiveDreaming: {},
  ethicsSafety: {},
  multiCivilization: {},
};

export class CivilizationOrchestrator {
  private readonly config: CivilizationConfig;
  private readonly network: BrainNetwork;
  private readonly peerDiscovery: PeerDiscovery;
  private readonly socialCognition: SocialCognitionEngine;
  private readonly collectiveMemory: CollectiveMemorySync;
  private readonly governance: GovernanceSystem;
  private readonly resourceEconomy: ResourceEconomy;
  private readonly cultureEngine: CultureEngine;
  private readonly roleSpecialization: RoleSpecialization;
  private readonly collectiveGoals: CollectiveGoalSystem;
  private readonly visualization: CivilizationVisualization;
  private readonly trustReputation: TrustReputationSystem;
  private readonly interBrainMemory: InterBrainMemorySystem;
  private readonly emergentOrg: EmergentOrganization;
  private readonly collectiveImagination: CollectiveImagination;
  private readonly languageEvolution: LanguageEvolutionSystem;
  private readonly civilizationTwin: CivilizationTwinModel;
  private readonly simulation: CivilizationSimulationEngine;
  private readonly collectiveDreaming: CollectiveDreaming;
  private readonly ethicsSafety: EthicsSafetySystem;
  private readonly multiCivilization: MultiCivilizationSystem;
  private running = false;
  private myDescriptor: BrainDescriptor | null = null;

  constructor(config: Partial<CivilizationConfig> = {}) {
    this.config = { ...DEFAULT_CIVILIZATION_CONFIG, ...config };

    const networkHandlers: NetworkEventHandlers = {
      onPeerConnected: (peer) => {
        this.socialCognition.recordInteraction(peer.id, "exchange", "success", "Peer connected");
      },
      onPeerDisconnected: (peerId) => {
        this.visualization.recordActivity("peer_disconnect", [peerId], `Peer ${peerId} disconnected`, 0.5);
      },
      onMessageReceived: (peerId, message) => {
        this.collectiveMemory?.handleIncomingMessage(peerId, message);
        this.socialCognition.updateFromPeerMessage(peerId, message);
      },
    };

    this.network = createBrainNetwork(this.config.brainNetwork, networkHandlers);

    this.peerDiscovery = createPeerDiscovery(this.network, this.config.peerDiscovery);

    this.socialCognition = createSocialCognition(this.config.socialCognition);

    const memoryHandlers: MemorySyncEventHandlers = {
      onMemoryReceived: (peerId, memories) => {
        this.visualization.recordActivity("memory_share", [peerId], `Received ${memories.length} memories`, memories.length * 0.1);
      },
      onSyncComplete: (peerId, count) => {
        if (count > 0) {
          this.visualization.recordActivity("memory_sync", [peerId], `Synced ${count} memories`, count * 0.1);
        }
      },
    };

    this.collectiveMemory = createCollectiveMemory(this.network, this.config.collectiveMemory, memoryHandlers);

    const governanceHandlers: GovernanceEventHandlers = {
      onProposalPassed: (proposal) => {
        this.visualization.recordActivity("governance", proposal.assignedBrainIds, `Proposal passed: ${proposal.title}`, 1);
      },
      onProposalRejected: (proposal) => {
        this.visualization.recordActivity("governance", proposal.assignedBrainIds, `Proposal rejected: ${proposal.title}`, 0.5);
      },
    };

    this.governance = createGovernance(this.network, this.config.governance, governanceHandlers);

    const economyHandlers: ResourceMarketEventHandlers = {
      onAllocationCreated: (allocation) => {
        this.visualization.recordActivity("resource", [], `Resource allocated: ${allocation.amount}`, 0.3);
      },
      onPriceChanged: (_type, _newPrice) => {
        // Could log price changes
      },
    };

    this.resourceEconomy = createResourceEconomy(this.network, this.config.resourceEconomy, economyHandlers);

    const cultureHandlers: CultureEventHandlers = {
      onPracticeAdopted: (practice) => {
        this.visualization.recordActivity("culture", practice.adoptedBy, `Practice adopted: ${practice.name}`, 0.5);
      },
      onCultureShift: (from, to) => {
        this.visualization.recordActivity("culture", [], `Culture shift: ${from} → ${to}`, 1);
      },
    };

    this.cultureEngine = createCultureEngine(this.network, this.config.cultureEngine, cultureHandlers);

    const roleHandlers: RoleEventHandlers = {
      onGuildFormed: (group) => {
        this.visualization.recordActivity("role", group.members.map((m) => m.brainId), `Guild formed: ${group.name}`, 1);
      },
      onRoleRotation: (brainId, oldRole, newRole) => {
        this.visualization.recordActivity("role", [brainId], `Role rotation: ${oldRole} → ${newRole}`, 0.3);
      },
    };

    this.roleSpecialization = createRoleSpecialization(this.network, this.config.roleSpecialization, roleHandlers);

    const goalHandlers: GoalEventHandlers = {
      onGoalCompleted: (goal) => {
        this.visualization.recordActivity("goal", goal.assignedBrainIds, `Goal completed: ${goal.title}`, goal.priority / 50);
      },
      onGoalAbandoned: (goal) => {
        this.visualization.recordActivity("goal", goal.assignedBrainIds, `Goal abandoned: ${goal.title}`, 0.3);
      },
    };

    this.collectiveGoals = createCollectiveGoals(this.network, this.config.collectiveGoals, goalHandlers);

    this.visualization = createCivilizationVisualization(
      this.network,
      this.socialCognition,
      this.collectiveGoals,
      this.roleSpecialization,
      this.config.visualization,
    );

    this.governance.setTrustEvaluator((brainId) => this.socialCognition.getRelationship(brainId)?.trust ?? 0.5);
    this.collectiveGoals.setTrustEvaluator((brainId) => this.socialCognition.getRelationship(brainId)?.trust ?? 0.5);

    // --- Advanced + maturity layers (architecture components #4, #11–#19) ---

    const trustReputationHandlers: TrustReputationEventHandlers = {
      onReputationChanged: (brainId, _old, next) => {
        this.visualization.recordActivity("trust", [brainId], `Reputation updated: ${next.toFixed(2)}`, Math.abs(next - 0.5));
      },
      onSybilDetected: (signal) => {
        this.visualization.recordActivity("trust", [signal.reporterId], `Sybil signal: ${signal.reason}`, 1);
      },
    };
    this.trustReputation = createTrustReputation(this.network, this.config.trustReputation, trustReputationHandlers);
    // The reporter's own first-hand standing (Sybil resistance) comes from socialCognition.
    this.trustReputation.setSelfTrustProvider((brainId) => this.socialCognition.getRelationship(brainId)?.trust ?? 0.5);

    this.interBrainMemory = createInterBrainMemory(this.config.interBrainMemory);

    const emergentOrgHandlers: EmergentOrgEventHandlers = {
      onGroupFormed: (group) => {
        this.visualization.recordActivity("role", group.members.map((m) => m.brainId), `Emergent group: ${group.name}`, 0.8);
      },
      onPhaseChanged: (groupId, phase) => {
        this.visualization.recordActivity("role", [], `Group ${groupId} → ${phase}`, 0.2);
      },
      onGroupDissolved: (group) => {
        this.visualization.recordActivity("role", [], `Group dissolved: ${group.name}`, 0.3);
      },
    };
    this.emergentOrg = createEmergentOrg(this.network, this.config.emergentOrg, emergentOrgHandlers);

    const imaginationHandlers: CollectiveImaginationEventHandlers = {
      onSessionStarted: (session) => {
        this.visualization.recordActivity("goal", session.participants, `Imagination: ${session.topic}`, 0.5);
      },
      onSessionCompleted: (session) => {
        this.visualization.recordActivity("goal", session.participants, `Imagination resolved: ${session.topic}`, 0.7);
      },
    };
    this.collectiveImagination = createCollectiveImagination(this.network, this.config.collectiveImagination, imaginationHandlers);

    this.languageEvolution = createLanguageEvolution(this.config.languageEvolution);

    this.simulation = createCivilizationSimulation();

    const dreamingHandlers: CollectiveDreamingEventHandlers = {
      onDreamStarted: (cycle) => {
        this.visualization.recordActivity("culture", cycle.participants, `Dreaming: ${cycle.focus}`, 0.3);
      },
      onDreamConsolidated: (cycle) => {
        this.visualization.recordActivity("culture", cycle.participants, `Dream consolidated: ${cycle.focus} (+${cycle.totalGain.toFixed(2)})`, cycle.totalGain);
      },
    };
    this.collectiveDreaming = createCollectiveDreaming(this.network, this.config.collectiveDreaming, dreamingHandlers);

    const ethicsHandlers: EthicsSafetyEventHandlers = {
      onAlertRaised: (alert) => {
        this.visualization.recordActivity("governance", alert.affectedBrainIds, `Alert (${alert.severity}): ${alert.type}`, alert.severity === "critical" ? 1 : 0.5);
      },
      onBrainQuarantined: (brainId, reason) => {
        this.visualization.recordActivity("governance", [brainId], `Quarantined: ${reason}`, 1);
      },
    };
    this.ethicsSafety = createEthicsSafety(this.network, this.config.ethicsSafety, ethicsHandlers);

    const multiCivHandlers: MultiCivilizationEventHandlers = {
      onCivilizationRegistered: (civ) => {
        this.visualization.recordActivity("governance", civ.foundingBrains, `Civilization founded: ${civ.name}`, 1);
      },
      onBrainJoined: (civId, brainId) => {
        this.visualization.recordActivity("social", [brainId], `Joined civilization ${civId}`, 0.4);
      },
    };
    this.multiCivilization = createMultiCivilization(this.network, this.config.multiCivilization, multiCivHandlers);

    // The digital twin reads the live engines through a decoupled provider seam.
    this.civilizationTwin = createCivilizationTwin(this.config.civilizationTwin);
    this.civilizationTwin.setProviders({
      brainCount: () => this.network.getPeerCount() + 1,
      interactionCount: () => this.interBrainMemory.count(),
      activeGoals: () => this.collectiveGoals.getAllGoals().filter((g) => g.status === "in-progress" || g.status === "accepted").length,
      memorySharedCount: () => this.collectiveMemory.getAllLocalMemories().length,
      culturalCohesion: () => {
        const evolution = this.cultureEngine.getCultureEvolution();
        return evolution ? 1 / (1 + evolution.minorityCultures.length) : 1;
      },
      governanceDecisions: () => this.governance.getAllProposals().filter((p) => p.status === "completed" || p.status === "abandoned").length,
      groupMemberships: () => this.emergentOrg.getActiveGroups().reduce((sum, g) => sum + g.members.filter((m) => m.isActive).length, 0),
      trustEdges: () => this.socialCognition.getAllRelationships().map((r) => ({ fromBrainId: "self", toBrainId: r.peerId, trust: r.trust })),
    });
  }

  async start(descriptor: BrainDescriptor): Promise<void> {
    if (this.running) return;

    this.myDescriptor = descriptor;

    this.socialCognition.setMyRole?.(descriptor.preferredRole as any ?? "generalist");
    this.governance.setMyBrainId?.(descriptor.id);
    this.resourceEconomy.setMyBrainId?.(descriptor.id);
    this.cultureEngine.setMyBrainId?.(descriptor.id);
    this.cultureEngine.setMyCultureType?.(descriptor.cultureType as any ?? "generalist");
    this.roleSpecialization.setMyBrainId?.(descriptor.id);
    this.collectiveGoals.setMyBrainId?.(descriptor.id);
    // Hard calls (no optional chaining): a missing method must fail loudly, not no-op.
    this.trustReputation.setMyBrainId(descriptor.id);
    this.emergentOrg.setMyBrainId(descriptor.id);
    this.collectiveImagination.setMyBrainId(descriptor.id);
    this.collectiveDreaming.setMyBrainId(descriptor.id);
    this.ethicsSafety.setMyBrainId(descriptor.id);
    this.multiCivilization.setMyBrainId(descriptor.id);

    await this.network.start(descriptor);
    await this.peerDiscovery.start(descriptor);

    this.socialCognition.start?.();
    this.collectiveMemory.start?.();
    this.governance.start?.();
    this.resourceEconomy.start?.();
    this.cultureEngine.start?.();
    this.roleSpecialization.start?.();
    this.collectiveGoals.start?.();
    this.visualization.start?.();
    // interBrainMemory + languageEvolution are pure stores with no start/stop lifecycle.
    this.trustReputation.start();
    this.emergentOrg.start();
    this.collectiveImagination.start();
    this.civilizationTwin.start();
    this.simulation.start();
    this.collectiveDreaming.start();
    this.ethicsSafety.start();
    this.multiCivilization.start();

    this.running = true;
    console.log("[CivilizationOrchestrator] Started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.multiCivilization.stop();
    this.ethicsSafety.stop();
    this.collectiveDreaming.stop();
    this.simulation.stop();
    this.civilizationTwin.stop();
    this.collectiveImagination.stop();
    this.emergentOrg.stop();
    this.trustReputation.stop();
    this.visualization.stop?.();
    this.collectiveGoals.stop?.();
    this.roleSpecialization.stop?.();
    this.cultureEngine.stop?.();
    this.resourceEconomy.stop?.();
    this.governance.stop?.();
    this.collectiveMemory.stop?.();
    this.socialCognition.stop?.();
    this.peerDiscovery.stop?.();
    await this.network.stop?.();

    this.running = false;
    console.log("[CivilizationOrchestrator] Stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getSystem(): CivilizationSystem {
    return {
      network: this.network,
      peerDiscovery: this.peerDiscovery,
      socialCognition: this.socialCognition,
      collectiveMemory: this.collectiveMemory,
      governance: this.governance,
      resourceEconomy: this.resourceEconomy,
      cultureEngine: this.cultureEngine,
      roleSpecialization: this.roleSpecialization,
      collectiveGoals: this.collectiveGoals,
      visualization: this.visualization,
      trustReputation: this.trustReputation,
      interBrainMemory: this.interBrainMemory,
      emergentOrg: this.emergentOrg,
      collectiveImagination: this.collectiveImagination,
      languageEvolution: this.languageEvolution,
      civilizationTwin: this.civilizationTwin,
      simulation: this.simulation,
      collectiveDreaming: this.collectiveDreaming,
      ethicsSafety: this.ethicsSafety,
      multiCivilization: this.multiCivilization,
    };
  }

  getSnapshot() {
    return this.visualization.getSnapshot();
  }

  getTwin() {
    return this.civilizationTwin.getLatest();
  }

  getSocialGraph() {
    return this.visualization.getSocialGraph();
  }

  getTrustNetwork() {
    return this.visualization.getTrustNetwork();
  }

  getCivilizationMap() {
    return this.visualization.getCivilizationMap();
  }
}

let orchestrator: CivilizationOrchestrator | null = null;

export function createCivilization(config?: Partial<CivilizationConfig>): CivilizationOrchestrator {
  if (!orchestrator) {
    orchestrator = new CivilizationOrchestrator(config);
  }
  return orchestrator;
}

export function getCivilization(): CivilizationOrchestrator | null {
  return orchestrator;
}
