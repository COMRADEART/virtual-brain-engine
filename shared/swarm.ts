export type SwarmNodeType =
  | "memory"
  | "execution"
  | "reasoning"
  | "tool"
  | "observer"
  | "simulation"
  | "ui"
  | "context"
  | "reflection"
  | "evolution"
  | "organism";

export type SwarmNodeLocation = "local" | "remote" | "cloud" | "worker";
export type SwarmOperationMode = "offline" | "hybrid" | "isolated-secure" | "cloud-assisted";
export type SwarmHealth = "healthy" | "degraded" | "offline";
export type SwarmTrustLevel = "system" | "trusted" | "sandboxed" | "untrusted";
export type SwarmTaskState = "queued" | "routed" | "running" | "completed" | "failed";
export type SwarmPrivacyMode = "local-first" | "offline-only" | "hybrid-allowed" | "cloud-allowed";

export interface SwarmCapabilityDescriptor {
  id: string;
  label: string;
  category: SwarmNodeType;
  cost: number;
  requiresNetwork: boolean;
  permissions: string[];
  modelProfile?: string;
}

export interface SwarmResourceUsage {
  cpu: number;
  ram: number;
  gpu: number;
  batteryImpact: number;
  thermalLoad: number;
  latencyMs: number;
  activeTasks: number;
}

export interface SwarmNodeDescriptor {
  id: string;
  name: string;
  organ: string;
  type: SwarmNodeType;
  location: SwarmNodeLocation;
  mode: SwarmOperationMode;
  health: SwarmHealth;
  trust: SwarmTrustLevel;
  capabilities: SwarmCapabilityDescriptor[];
  permissions: string[];
  resources: SwarmResourceUsage;
  activeTasks: string[];
  modelProfile?: string;
  endpoint?: string;
  lastHeartbeatAt: string;
  registeredAt: string;
}

export interface SwarmRouteHop {
  nodeId: string;
  nodeName: string;
  capability: string;
  reason: string;
  score: number;
}

export interface SwarmTask {
  id: string;
  goal: string;
  requiredCapabilities: string[];
  priority: number;
  privacyMode: SwarmPrivacyMode;
  state: SwarmTaskState;
  assignedNodeId?: string;
  attempts: number;
  trace: SwarmRouteHop[];
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmConsensusOpinion {
  nodeId: string;
  nodeName: string;
  planId: string;
  summary: string;
  confidence: number;
  risk: number;
  weight: number;
}

export interface SwarmConsensusRound {
  id: string;
  taskId?: string;
  question: string;
  opinions: SwarmConsensusOpinion[];
  winningPlanId: string;
  decision: string;
  confidence: number;
  risk: number;
  createdAt: string;
}

export interface SwarmTopologyEdge {
  fromId: string;
  toId: string;
  kind: "routes-to" | "replicates" | "observes" | "reports-to" | "votes-with";
  weight: number;
  active: boolean;
}

export type SwarmEvent =
  | { kind: "node-registered"; node: SwarmNodeDescriptor; at: string }
  | { kind: "node-heartbeat"; nodeId: string; health: SwarmHealth; resources: SwarmResourceUsage; at: string }
  | { kind: "task-queued"; task: SwarmTask; at: string }
  | { kind: "task-routed"; task: SwarmTask; route: SwarmRouteHop; at: string }
  | { kind: "task-completed"; task: SwarmTask; at: string }
  | { kind: "consensus-completed"; round: SwarmConsensusRound; at: string }
  | { kind: "policy-updated"; policy: SwarmPolicy; at: string };

export interface SwarmPolicy {
  operatingMode: SwarmOperationMode;
  localFirst: boolean;
  allowRemoteNodes: boolean;
  allowCloudNodes: boolean;
  encryptedSync: boolean;
  maxTaskAttempts: number;
  consensusThreshold: number;
}

export interface SwarmSnapshot {
  generatedAt: string;
  policy: SwarmPolicy;
  nodes: SwarmNodeDescriptor[];
  tasks: SwarmTask[];
  recentEvents: SwarmEvent[];
  topology: SwarmTopologyEdge[];
  consensus: SwarmConsensusRound[];
}
