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
import type { BrainDescriptor as SharedBrainDescriptor, CultureType, ResourceCapacity, ResourceUsage } from "../../../shared/civilization.js";

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
      onPriceChanged: (type, newPrice) => {
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

    this.running = true;
    console.log("[CivilizationOrchestrator] Started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;

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
    };
  }

  getSnapshot() {
    return this.visualization.getSnapshot();
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

function createBrainNetworkWithDescriptor(
  config: Partial<BrainNetworkConfig>,
  handlers: NetworkEventHandlers,
  descriptor: BrainDescriptor,
) {
  return new BrainNetwork(config, handlers);
}

function createPeerDiscoveryWithNetwork(
  network: BrainNetwork,
  config: Partial<PeerDiscoveryConfig>,
  descriptor: BrainDescriptor,
) {
  return new PeerDiscovery(network, config);
}