import type {
  BrainPeer,
  CivilizationSnapshot,
  CultureType,
  HealthStatus,
  ResourceType,
  TopologyNode,
  TopologyEdge,
  ActivityEvent,
  BrainRole,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";
import { SocialCognitionEngine } from "./socialCognition.js";
import { CollectiveGoalSystem } from "./collectiveGoals.js";
import { RoleSpecialization } from "./roleSpecialization.js";

export interface VisualizationConfig {
  updateIntervalMs: number;
  maxActivityEvents: number;
  maxTopologyNodes: number;
}

const DEFAULT_CONFIG: VisualizationConfig = {
  updateIntervalMs: 5000,
  maxActivityEvents: 100,
  maxTopologyNodes: 200,
};

export class CivilizationVisualization {
  private readonly network: BrainNetwork;
  private readonly socialCognition: SocialCognitionEngine;
  private readonly collectiveGoals: CollectiveGoalSystem;
  private readonly roleSpecialization: RoleSpecialization;
  private readonly config: VisualizationConfig;
  private readonly activityEvents: ActivityEvent[] = [];
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    network: BrainNetwork,
    socialCognition: SocialCognitionEngine,
    collectiveGoals: CollectiveGoalSystem,
    roleSpecialization: RoleSpecialization,
    config: Partial<VisualizationConfig> = {},
  ) {
    this.network = network;
    this.socialCognition = socialCognition;
    this.collectiveGoals = collectiveGoals;
    this.roleSpecialization = roleSpecialization;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    this.updateTimer = setInterval(() => {
      // Periodic updates could trigger WebSocket notifications
    }, this.config.updateIntervalMs);
    this.updateTimer.unref?.();
  }

  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  getSnapshot(): CivilizationSnapshot {
    const peers = this.network.getAllPeers();
    const goals = this.collectiveGoals.getAllGoals();
    const roles = this.roleSpecialization.getAllRoleClaims();

    const peerHealth: Record<HealthStatus, number> = {
      healthy: 0,
      degraded: 0,
      critical: 0,
      offline: 0,
    };

    for (const peer of peers) {
      peerHealth[peer.descriptor.health]++;
    }

    const trustDistribution = this.calculateTrustDistribution(peers);

    const cultureCounts = new Map<CultureType, number>();
    for (const peer of peers) {
      const culture = peer.descriptor.cultureType ?? "generalist";
      cultureCounts.set(culture, (cultureCounts.get(culture) ?? 0) + 1);
    }

    let dominantCulture: CultureType = "generalist";
    let maxCount = 0;
    for (const [culture, count] of cultureCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominantCulture = culture;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      totalPeers: peers.length,
      totalSocieties: this.roleSpecialization.getAllGroups().length,
      totalGroups: this.roleSpecialization.getAllGroups().filter((g) => g.isActive).length,
      activeGoals: goals.filter((g) => g.status === "in-progress").length,
      cultureType: dominantCulture,
      governanceModel: "consensus",
      resourceUtilization: this.getResourceUtilization(),
      peerHealth,
      trustDistribution,
      recentActivity: this.activityEvents.slice(-50),
      topology: this.buildTopology(peers),
    };
  }

  getSocialGraph(): { nodes: SocialGraphNode[]; edges: SocialGraphEdge[] } {
    const peers = this.network.getAllPeers();
    const nodes: SocialGraphNode[] = [];
    const edges: SocialGraphEdge[] = [];

    const relationships = this.socialCognition.getAllRelationships();

    for (const peer of peers) {
      nodes.push({
        id: peer.id,
        label: peer.descriptor.name,
        role: this.roleSpecialization.getRole(peer.id) ?? "generalist",
        trust: this.socialCognition.getRelationship(peer.id)?.trust ?? 0.5,
        isConnected: peer.isConnected,
        health: peer.descriptor.health,
      });
    }

    const addedEdges = new Set<string>();

    for (const rel of relationships) {
      const edgeKey = [rel.peerId, "self"].sort().join("-");
      if (!addedEdges.has(edgeKey)) {
        addedEdges.add(edgeKey);
        edges.push({
          from: "self",
          to: rel.peerId,
          weight: rel.trust,
          kind: "trust",
        });
      }
    }

    for (const peer of peers) {
      const rel = relationships.find((r) => r.peerId === peer.id);
      const edgeKey = [peer.id, this.socialCognition.getMyRole()].sort().join("-");
      if (rel && !addedEdges.has(edgeKey)) {
        addedEdges.add(edgeKey);
        edges.push({
          from: "self",
          to: peer.id,
          weight: rel.trust,
          kind: rel.relationshipType === "ally" ? "trust" : rel.relationshipType === "competitor" ? "conflict" : "neutral",
        });
      }
    }

    return { nodes, edges };
  }

  getTrustNetwork(): { nodes: TrustNode[]; edges: TrustEdge[] } {
    const peers = this.network.getAllPeers();
    const nodes: TrustNode[] = [];
    const edges: TrustEdge[] = [];
    const relationships = this.socialCognition.getAllRelationships();

    for (const peer of peers) {
      const trustScore = this.socialCognition.getTrustScore(peer.id);
      nodes.push({
        id: peer.id,
        name: peer.descriptor.name,
        overallTrust: trustScore?.overallTrust ?? 0.5,
        competenceTrust: trustScore?.competenceTrust ?? 0.5,
        reliabilityTrust: trustScore?.reliabilityTrust ?? 0.5,
        safetyTrust: trustScore?.safetyTrust ?? 0.5,
      });
    }

    const addedEdges = new Set<string>();
    for (const rel of relationships) {
      const key = [rel.peerId, "self"].sort().join("-");
      if (!addedEdges.has(key) && rel.trust > 0.3) {
        addedEdges.add(key);
        edges.push({
          from: "self",
          to: rel.peerId,
          trust: rel.trust,
        });
      }
    }

    return { nodes, edges };
  }

  getResourceEconomyVisualization(): {
    offers: ResourceOfferViz[];
    requests: ResourceRequestViz[];
    flows: ResourceFlowViz[];
  } {
    return {
      offers: [],
      requests: [],
      flows: [],
    };
  }

  getSpecializationClusters(): ClusterVisualization[] {
    const groups = this.roleSpecialization.getAllGroups();
    const clusters: ClusterVisualization[] = [];

    const typeGroups = new Map<string, typeof groups>();
    for (const group of groups) {
      if (!typeGroups.has(group.type)) {
        typeGroups.set(group.type, []);
      }
      typeGroups.get(group.type)!.push(group);
    }

    for (const [type, groupList] of typeGroups) {
      const memberIds = new Set<string>();
      let totalContributions = 0;

      for (const group of groupList) {
        for (const member of group.members) {
          memberIds.add(member.brainId);
          totalContributions += member.contributions;
        }
      }

      clusters.push({
        id: type,
        label: `${type} collective`,
        type,
        memberCount: memberIds.size,
        totalContributions,
        groups: groupList.map((g) => ({
          id: g.id,
          name: g.name,
          activeGoals: g.goals.length,
          achievements: g.achievements.length,
        })),
      });
    }

    return clusters;
  }

  getCivilizationMap(): {
    regions: RegionViz[];
    connections: RegionConnection[];
  } {
    const peers = this.network.getAllPeers();
    const regions: RegionViz[] = [];
    const connections: RegionConnection[] = [];

    const cultureGroups = new Map<CultureType, string[]>();
    for (const peer of peers) {
      const culture = peer.descriptor.cultureType ?? "generalist";
      if (!cultureGroups.has(culture)) {
        cultureGroups.set(culture, []);
      }
      cultureGroups.get(culture)!.push(peer.id);
    }

    const regionPositions: Record<CultureType, { x: number; y: number }> = {
      "safety-first": { x: 0, y: 0 },
      "speed-optimized": { x: 100, y: 0 },
      "deep-research": { x: 0, y: 100 },
      creative: { x: 100, y: 100 },
      generalist: { x: 50, y: 50 },
    };

    for (const [culture, memberIds] of cultureGroups) {
      const pos = regionPositions[culture];
      regions.push({
        id: culture,
        label: `${culture} region`,
        culture,
        x: pos.x,
        y: pos.y,
        memberIds,
        density: memberIds.length,
      });
    }

    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const r1 = regions[i];
        const r2 = regions[j];

        const peerIds1 = new Set(r1.memberIds);
        const peerIds2 = new Set(r2.memberIds);

        let sharedCount = 0;
        for (const id of peerIds1) {
          if (peerIds2.has(id)) sharedCount++;
        }

        if (sharedCount > 0) {
          connections.push({
            from: r1.id,
            to: r2.id,
            strength: sharedCount / Math.max(peerIds1.size, peerIds2.size),
            sharedMembers: sharedCount,
          });
        }
      }
    }

    return { regions, connections };
  }

  recordActivity(type: string, actorIds: string[], summary: string, impact: number = 1): void {
    const event: ActivityEvent = {
      id: `event-${Date.now()}`,
      type,
      actorIds,
      summary,
      impact,
      timestamp: new Date().toISOString(),
    };

    this.activityEvents.push(event);

    if (this.activityEvents.length > this.config.maxActivityEvents) {
      this.activityEvents.shift();
    }
  }

  private buildTopology(peers: BrainPeer[]): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
    const nodes: TopologyNode[] = [];
    const edges: TopologyEdge[] = [];

    const maxNodes = this.config.maxTopologyNodes;
    const displayPeers = peers.slice(0, maxNodes);

    for (const peer of displayPeers) {
      nodes.push({
        brainId: peer.id,
        name: peer.descriptor.name,
        role: this.roleSpecialization.getRole(peer.id) ?? "generalist",
        trust: this.socialCognition.getRelationship(peer.id)?.trust ?? 0.5,
        isConnected: peer.isConnected,
      });
    }

    const relationships = this.socialCognition.getAllRelationships();
    const addedEdges = new Set<string>();

    for (const rel of relationships) {
      const key = [rel.peerId, "self"].sort().join("-");
      if (!addedEdges.has(key)) {
        addedEdges.add(key);
        edges.push({
          fromId: "self",
          toId: rel.peerId,
          kind: "trust",
          weight: rel.trust,
        });
      }
    }

    for (let i = 0; i < displayPeers.length; i++) {
      for (let j = i + 1; j < displayPeers.length; j++) {
        const p1 = displayPeers[i];
        const p2 = displayPeers[j];
        const rel = relationships.find((r) => r.peerId === p1.id);

        if (rel && rel.trust > 0.6) {
          edges.push({
            fromId: p1.id,
            toId: p2.id,
            kind: "social",
            weight: rel.trust * 0.5,
          });
        }
      }
    }

    return { nodes, edges };
  }

  private calculateTrustDistribution(peers: BrainPeer[]): { low: number; medium: number; high: number } {
    let low = 0, medium = 0, high = 0;

    for (const peer of peers) {
      const relationship = this.socialCognition.getRelationship(peer.id);
      const trust = relationship?.trust ?? 0.5;

      if (trust < 0.4) low++;
      else if (trust < 0.7) medium++;
      else high++;
    }

    const total = peers.length || 1;
    return {
      low: low / total,
      medium: medium / total,
      high: high / total,
    };
  }

  private getResourceUtilization(): Record<ResourceType, number> {
    const peers = this.network.getAllPeers();
    let totalCompute = 0, maxCompute = 0;
    let totalMemory = 0, maxMemory = 0;
    let totalGpu = 0, maxGpu = 0;

    for (const peer of peers) {
      const usage = peer.descriptor.resourceUsage;
      totalCompute += usage.cpu;
      totalMemory += usage.ram;
      totalGpu += usage.gpu;
      maxCompute += 1;
      maxMemory += 1;
      maxGpu += 1;
    }

    return {
      compute: maxCompute > 0 ? totalCompute / maxCompute : 0,
      memory: maxMemory > 0 ? totalMemory / maxMemory : 0,
      gpu: maxGpu > 0 ? totalGpu / maxGpu : 0,
      simulation: 0.3,
      knowledge: 0.5,
      skill: 0.4,
    };
  }
}

interface SocialGraphNode {
  id: string;
  label: string;
  role: BrainRole;
  trust: number;
  isConnected: boolean;
  health: HealthStatus;
}

interface SocialGraphEdge {
  from: string;
  to: string;
  weight: number;
  kind: "trust" | "conflict" | "neutral";
}

interface TrustNode {
  id: string;
  name: string;
  overallTrust: number;
  competenceTrust: number;
  reliabilityTrust: number;
  safetyTrust: number;
}

interface TrustEdge {
  from: string;
  to: string;
  trust: number;
}

interface ResourceOfferViz {
  id: string;
  resourceType: ResourceType;
  amount: number;
  provider: string;
}

interface ResourceRequestViz {
  id: string;
  resourceType: ResourceType;
  amount: number;
  requester: string;
  urgency: string;
}

interface ResourceFlowViz {
  from: string;
  to: string;
  resourceType: ResourceType;
  amount: number;
}

interface ClusterVisualization {
  id: string;
  label: string;
  type: string;
  memberCount: number;
  totalContributions: number;
  groups: { id: string; name: string; activeGoals: number; achievements: number }[];
}

interface RegionViz {
  id: string;
  label: string;
  culture: CultureType;
  x: number;
  y: number;
  memberIds: string[];
  density: number;
}

interface RegionConnection {
  from: string;
  to: string;
  strength: number;
  sharedMembers: number;
}

let singleton: CivilizationVisualization | null = null;

export function createCivilizationVisualization(
  network: BrainNetwork,
  socialCognition: SocialCognitionEngine,
  collectiveGoals: CollectiveGoalSystem,
  roleSpecialization: RoleSpecialization,
  config?: Partial<VisualizationConfig>,
): CivilizationVisualization {
  if (!singleton) {
    singleton = new CivilizationVisualization(network, socialCognition, collectiveGoals, roleSpecialization, config);
  }
  return singleton;
}

export function getCivilizationVisualization(): CivilizationVisualization | null {
  return singleton;
}