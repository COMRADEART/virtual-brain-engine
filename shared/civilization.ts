export const CIVILIZATION_PROTOCOL_VERSION = "1.0.0";
export const CIVILIZATION_DEFAULT_PORT = 8788;
export const CIVILIZATION_BROADCAST_PORT = 8789;

export type BrainRole =
  | "planner"
  | "memory-archivist"
  | "simulation-researcher"
  | "workflow-optimizer"
  | "safety-guardian"
  | "execution-coordinator"
  | "robotics-controller"
  | "research-lead"
  | "generalist";

export type CultureType =
  | "safety-first"
  | "speed-optimized"
  | "deep-research"
  | "creative"
  | "generalist";

export type RelationshipType = "ally" | "competitor" | "neutral" | "unknown";

export type PrivacyLevel = "public" | "shared" | "private";

export type HealthStatus = "healthy" | "degraded" | "critical" | "offline";

export type GovernanceModel =
  | "direct-democracy"
  | "representative"
  | "weighted-expertise"
  | "consensus"
  | "dictatorship";

export type VoteType = "majority" | "weighted" | "ranked-choice" | "consensus" | "veto";

export type ResourceType =
  | "compute"
  | "memory"
  | "gpu"
  | "simulation"
  | "knowledge"
  | "skill";

export type GoalStatus = "proposed" | "accepted" | "in-progress" | "completed" | "abandoned";

export interface ResourceCapacity {
  computeUnits: number;
  memoryMB: number;
  gpuUnits: number;
  simulationBudget: number;
  networkBandwidthMbps: number;
}

export interface ResourceUsage {
  cpu: number;
  ram: number;
  gpu: number;
  batteryImpact: number;
  thermalLoad: number;
  latencyMs: number;
  activeTasks: number;
}

export interface BrainDescriptor {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  resources: ResourceCapacity;
  resourceUsage: ResourceUsage;
  civilizationId?: string;
  societyId?: string;
  cultureType?: CultureType;
  preferredRole?: BrainRole;
  publicKey: string;
  health: HealthStatus;
  trust?: number;
  announcedAt: string;
  lastSeenAt: string;
}

export interface InterBrainMessage {
  id: string;
  type: InterBrainMessageType;
  sourceBrainId: string;
  targetBrainId?: string;
  payload: unknown;
  timestamp: string;
  ttl?: number;
  expiresAt?: string;
}

export type InterBrainMessageType =
  | "handshake"
  | "handshake-ack"
  | "heartbeat"
  | "capability-query"
  | "capability-response"
  | "memory-share"
  | "memory-request"
  | "memory-response"
  | "memory-sync"
  | "task-delegate"
  | "task-bid"
  | "task-result"
  | "vote"
  | "vote-tally"
  | "proposal"
  | "proposal-accepted"
  | "proposal-rejected"
  | "resource-offer"
  | "resource-request"
  | "resource-allocation"
  | "trust-update"
  | "trust-query"
  | "trust-response"
  | "culture-share"
  | "culture-query"
  | "goal-propose"
  | "goal-accept"
  | "goal-decompose"
  | "goal-update"
  | "goal-complete"
  | "consensus-request"
  | "consensus-response"
  | "group-form"
  | "group-join"
  | "group-leave"
  | "group-update"
  | "discovery-announce"
  | "discovery-query"
  | "discovery-response"
  | "social-memory-store"
  | "social-memory-query"
  | "role-claim"
  | "role-query"
  | "civilization-invite"
  | "civilization-join"
  | "civilization-leave"
  | "emergency-alert"
  | "emergency-response"
  | "dream-sync"
  | "dream-result";

export interface BrainPeer {
  id: string;
  descriptor: BrainDescriptor;
  connection: PeerConnection;
  lastHeartbeat: string;
  latencyMs: number;
  isConnected: boolean;
}

export interface PeerConnection {
  type: "tcp" | "websocket" | "mDNS";
  address: string;
  port: number;
  establishedAt: string;
  messageCount: number;
  bytesTransferred: number;
}

export interface BrainRelationship {
  peerId: string;
  relationshipType: RelationshipType;
  trust: number;
  reliability: number;
  competence: number;
  safetyScore: number;
  sharedGoals: string[];
  totalInteractions: number;
  successfulCollaborations: number;
  failedInteractions: number;
  lastInteractionAt: string;
  firstInteractionAt: string;
  notes: string[];
}

export interface SocialModel {
  myRole: BrainRole;
  peerModels: Map<string, PeerBrainModel>;
  groupMemberships: Map<string, GroupMembership>;
  socialNorms: SocialNorm[];
  blockedPeers: Set<string>;
}

export interface PeerBrainModel {
  peerId: string;
  perceivedCapabilities: string[];
  perceivedReliability: number;
  perceivedIntent: "friendly" | "neutral" | "hostile" | "unknown";
  cooperationLikelihood: number;
  specializationStrengths: string[];
  preferredCommunicationStyle: "formal" | "casual" | "minimal";
  lastConversationAt?: string;
}

export interface GroupMembership {
  groupId: string;
  role: string;
  joinedAt: string;
  contributions: number;
  isActive: boolean;
}

export interface SocialNorm {
  id: string;
  description: string;
  agreedBy: string[];
  createdAt: string;
  enforcementLevel: "soft" | "hard";
}

export interface MemoryChunk {
  id: string;
  content: string;
  embedding: number[];
  memoryType: string;
  importance: number;
  privacy: PrivacyLevel;
  sourceBrainId: string;
  tags: string[];
  createdAt: string;
  accessCount: number;
  lastAccessedAt: string;
}

export interface MemorySyncState {
  brainId: string;
  lastSyncAt: string;
  syncedMemoryIds: Set<string>;
  pendingMemoryIds: string[];
  conflicts: MemoryConflict[];
}

export interface MemoryConflict {
  localId: string;
  remoteId: string;
  localContent: string;
  remoteContent: string;
  resolvedAt?: string;
  resolution?: "local" | "remote" | "merged";
}

export interface GovernanceProposal {
  id: string;
  title: string;
  description: string;
  type: "policy" | "resource" | "membership" | "leadership" | "constitution";
  status: GoalStatus;
  proposerId: string;
  assignedBrainIds: string[];
  votes: Map<string, Vote>;
  voteType: VoteType;
  quorumRequired: number;
  createdAt: string;
  deadline?: string;
  executedAt?: string;
  outcome?: "passed" | "rejected" | "expired";
}

export interface Vote {
  voterId: string;
  vote: "yes" | "no" | "abstain";
  weight: number;
  reasoning?: string;
  timestamp: string;
}

export interface DelegatedVote {
  delegatorId: string;
  delegateId: string;
  scope: string[];
  grantedAt: string;
  revokedAt?: string;
}

export interface ResourceOffer {
  id: string;
  resourceType: ResourceType;
  amount: number;
  unit: string;
  availableUntil?: string;
  price?: number;
  conditions?: ResourceCondition[];
}

export interface ResourceRequest {
  id: string;
  resourceType: ResourceType;
  amount: number;
  unit: string;
  urgency: "low" | "medium" | "high" | "critical";
  deadline?: string;
  maxPrice?: number;
}

export interface ResourceAllocation {
  id: string;
  offerId: string;
  requestId: string;
  amount: number;
  status: "pending" | "active" | "completed" | "cancelled";
  createdAt: string;
  completedAt?: string;
}

export interface ResourceCondition {
  type: "min-trust" | "min-relations" | "role-required" | "time-window";
  value: unknown;
}

export interface ResourceBalance {
  brainId: string;
  giveBalance: number;
  receiveBalance: number;
  totalGiven: number;
  totalReceived: number;
  lastSettledAt: string;
}

export interface CulturePractice {
  id: string;
  name: string;
  description: string;
  cultureType: CultureType;
  adoptedBy: string[];
  successRate: number;
  triedCount: number;
  lastAttemptAt?: string;
  evidenceIds: string[];
}

export interface CultureEvolution {
  civilizationId: string;
  dominantCulture: CultureType;
  minorityCultures: CultureType[];
  sharedAbstractions: string[];
  reasoningTraditions: string[];
  communicationPatterns: string[];
  divergenceMetrics: Record<string, number>;
  lastUpdatedAt: string;
}

export interface BrainRoleClaim {
  brainId: string;
  role: BrainRole;
  evidence: RoleEvidence[];
  endorsedBy: string[];
  disputedBy: string[];
  claimedAt: string;
  verifiedAt?: string;
}

export interface RoleEvidence {
  type: "task-completion" | "peer-review" | "self-assessment" | "demonstration";
  description: string;
  taskId?: string;
  rating?: number;
  timestamp: string;
}

export interface CollectiveGoal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  proposerId: string;
  assignedBrainIds: string[];
  subgoals: Subgoal[];
  progress: number;
  priority: number;
  deadline?: string;
  createdAt: string;
  completedAt?: string;
}

export interface Subgoal {
  id: string;
  goalId: string;
  title: string;
  assignedBrainId?: string;
  status: GoalStatus;
  dependsOn: string[];
  result?: unknown;
}

export interface EmergentGroup {
  id: string;
  name: string;
  type: "research" | "workflow" | "simulation" | "memory" | "robotics" | "crisis-response";
  purpose: string;
  members: GroupMember[];
  formedAt: string;
  dissolvedAt?: string;
  isActive: boolean;
  goals: string[];
  achievements: string[];
}

export interface GroupMember {
  brainId: string;
  role: string;
  joinedAt: string;
  contributions: number;
  isActive: boolean;
}

export interface InterBrainMemory {
  id: string;
  interactionType: "collaboration" | "trade" | "governance" | "conflict" | "exchange";
  participants: string[];
  outcome: "success" | "partial" | "failure";
  summary: string;
  lessonsLearned: string[];
  creditAssignment: Record<string, number>;
  createdAt: string;
}

export interface ImaginationSession {
  id: string;
  participants: string[];
  topic: string;
  mode: "fast" | "safe" | "sandbox" | "rollback" | "defer";
  branches: ImaginationBranch[];
  result?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ImaginationBranch {
  id: string;
  parentId?: string;
  description: string;
  probability: number;
  predictedOutcome: string;
  riskFactors: string[];
  votes: Map<string, "adopt" | "reject" | "defer">;
}

export interface TrustScore {
  brainId: string;
  overallTrust: number;
  competenceTrust: number;
  reliabilityTrust: number;
  safetyTrust: number;
  honestyTrust: number;
  temporalDecayFactor: number;
  lastUpdatedAt: string;
  evidenceCount: number;
}

export interface TrustEvidence {
  id: string;
  fromBrainId: string;
  aboutBrainId: string;
  trustAxis: "competence" | "reliability" | "safety" | "honesty";
  delta: number;
  context: string;
  taskId?: string;
  timestamp: string;
}

export interface CivilizationDescriptor {
  id: string;
  name: string;
  description: string;
  governanceModel: GovernanceModel;
  foundingBrains: string[];
  constitution?: string;
  memberBrainIds: Set<string>;
  guestBrainIds: Set<string>;
  createdAt: string;
  cultureType: CultureType;
  publicKey: string;
}

export interface CivilizationTwin {
  civilizationId: string;
  totalBrains: number;
  totalInteractions: number;
  activeGoals: number;
  totalMemoryShared: number;
  culturalCohesion: number;
  governanceDecisions: number;
  resourceFlows: ResourceFlow[];
  trustNetwork: TrustEdge[];
  groupMemberships: number;
  snapshotAt: string;
}

export interface ResourceFlow {
  fromBrainId: string;
  toBrainId: string;
  resourceType: ResourceType;
  amount: number;
  timestamp: string;
}

export interface TrustEdge {
  fromBrainId: string;
  toBrainId: string;
  trust: number;
}

export interface Society {
  id: string;
  name: string;
  civilizationId: string;
  memberIds: string[];
  purpose: string;
  formedAt: string;
  leaderId?: string;
}

export interface EmergencyAlert {
  id: string;
  type: "resource-exhaustion" | "trust-violation" | "governance-attack" | "external-threat" | "system-failure";
  severity: "warning" | "critical";
  reporterId: string;
  description: string;
  affectedBrainIds: string[];
  proposedActions: string[];
  status: "active" | "acknowledged" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}

export interface LanguageEvolution {
  civilizationId: string;
  sharedSymbols: Map<string, string>;
  abbreviations: Map<string, string>;
  reasoningShorthands: Map<string, string>;
  lastUpdatedAt: string;
}

export interface CivilizationSnapshot {
  generatedAt: string;
  totalPeers: number;
  totalSocieties: number;
  totalGroups: number;
  activeGoals: number;
  cultureType: CultureType;
  governanceModel: GovernanceModel;
  resourceUtilization: Record<ResourceType, number>;
  peerHealth: Record<HealthStatus, number>;
  trustDistribution: { low: number; medium: number; high: number };
  recentActivity: ActivityEvent[];
  topology: CivilizationTopology;
}

export interface CivilizationTopology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface TopologyNode {
  brainId: string;
  name: string;
  role: BrainRole;
  trust: number;
  isConnected: boolean;
}

export interface TopologyEdge {
  fromId: string;
  toId: string;
  kind: "trust" | "resource" | "memory" | "governance" | "social";
  weight: number;
}

export interface ActivityEvent {
  id: string;
  type: string;
  actorIds: string[];
  summary: string;
  impact: number;
  timestamp: string;
}