# Civiliztion Layer — Phase 3 Architecture Specification

## Overview

The Civilization Layer evolves the computer-brain ecosystem from isolated cognitive organisms into a **distributed civilization of synthetic minds**. Multiple brains form societies, develop cultures, govern themselves collectively, and coordinate resources across a peer-to-peer network.

## Core Concept

Each brain remains **autonomous, identity-preserving, and self-evolving**, but collectively they form:
- **Societies** — cooperating brain clusters
- **Collectives** — task-oriented brain groups
- **Civilizations** — large-scale brain networks with shared culture
- **Synthetic cultures** — emergent shared practices and reasoning traditions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CIVILIZATION LAYER                       │
├─────────────┬─────────────┬─────────────┬──────────────────┤
│   Society   │  Collective │   Culture   │   Governance     │
│   Engine    │   Manager   │   Engine   │   System         │
├─────────────┴─────────────┴─────────────┴──────────────────┤
│              Collective Memory & Knowledge Sync             │
├─────────────────────────────────────────────────────────────┤
│              Social Cognition Engine                        │
│         (Trust, Reputation, Relationships)                  │
├─────────────────────────────────────────────────────────────┤
│              Resource Economy                               │
├─────────────────────────────────────────────────────────────┤
│         Brain Network Transport (P2P/TCP/WS)                │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ (extends)
                              │
┌─────────────────────────────────────────────────────────────┐
│                   SWARM LAYER (Phase 2)                     │
│  Node Registry, Task Routing, Consensus, Privacy Policy    │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. Brain Network Transport (`brainNetwork.ts`)

**Responsibility:** Actual peer-to-peer communication between brains.

**Features:**
- TCP listener for incoming brain connections
- WebSocket upgrade support for browser clients
- Brain handshake protocol (capability exchange, auth)
- Heartbeat/keepalive with remote peers
- Connection registry with health tracking
- Message framing (JSON with header checksum)

**API:**
```typescript
interface BrainNetwork {
  listen(port: number): Promise<void>;
  connect(peerAddress: string): Promise<BrainPeer>;
  disconnect(peerId: string): void;
  broadcast(message: InterBrainMessage): void;
  send(peerId: string, message: InterBrainMessage): void;
  onPeerConnected(handler: (peer: BrainPeer) => void): void;
  onPeerDisconnected(handler: (peerId: string) => void): void;
  onMessage(handler: (peerId: string, message: InterBrainMessage) => void): void;
}
```

### 2. Peer Discovery (`peerDiscovery.ts`)

**Responsibility:** How brains find each other on the network.

**Features:**
- mDNS/DNS-SD announcement of brain presence
- Peer list broadcast (configurable bootstrap nodes)
- Peer capability advertisement
- Latency probing and geographic awareness
- Privacy-preserving discovery (doesn't reveal full capabilities initially)

**API:**
```typescript
interface PeerDiscovery {
  startDiscovery(): void;
  stopDiscovery(): void;
  announce(brainDescriptor: BrainDescriptor): void;
  findPeers(filter?: PeerFilter): Promise<BrainPeer[]>;
  onPeerFound(handler: (peer: BrainPeer) => void): void;
  onPeerLost(handler: (peerId: string) => void): void;
}
```

### 3. Social Cognition Engine (`socialCognition.ts`)

**Responsibility:** Model other brains as intelligent entities with relationships.

**Features:**
- **Brain modeling** — maintain mental models of peer capabilities/beliefs
- **Intention inference** — predict what other brains will do
- **Trust estimation** — dynamic trust scores based on interaction history
- **Reputation tracking** — historical reliability and quality metrics
- **Relationship typing** — ally, competitor, neutral, unknown
- **Cooperation modeling** — predict cooperation likelihood

**Data Model:**
```typescript
interface BrainRelationship {
  peerId: string;
  relationshipType: 'ally' | 'competitor' | 'neutral' | 'unknown';
  trust: number; // 0-1
  reliability: number; // 0-1
  sharedGoals: string[];
  conflictHistory: InteractionRecord[];
  cooperationHistory: InteractionRecord[];
  lastInteractionAt: string;
  totalInteractions: number;
  successfulCollaborations: number;
}

interface SocialModel {
  myRole: BrainRole;
  peerModels: Map<string, PeerBrainModel>;
  groupMemberships: string[];
  socialNorms: SocialNorm[];
}
```

### 4. Trust & Reputation System (`trustReputation.ts`)

**Responsibility:** Track and update trust scores for all peers.

**Features:**
- Multi-axis trust evaluation (competence, reliability, safety, honesty)
- Temporal trust decay
- Context-specific trust (trust in safety-critical vs. creative tasks)
- Third-party reputation propagation
- Sybil resistance signals
- Trust negotiation protocols

**Trust Score Formula:**
```
Trust(capability, context) = Σ(weight_i × evidence_i) × temporal_decay × context_modifier
```

### 5. Collective Memory Sync (`collectiveMemory.ts`)

**Responsibility:** Synchronize knowledge across brain boundaries.

**Features:**
- Selective memory sharing (privacy filters)
- Vector embedding sync for semantic search
- Conflict resolution (CRDT or LWW)
- Memory importance weighting
- Privacy levels: public, shared, private
- Cross-brain citation and reference

**API:**
```typescript
interface CollectiveMemory {
  shareMemory(memoryId: string, recipients: string[]): Promise<void>;
  requestMemory(peerId: string, query: string): Promise<MemoryHit[]>;
  syncEmbeddings(peerId: string): Promise<void>;
  resolveConflict(local: Memory, remote: Memory): Memory;
}
```

### 6. Governance System (`governance.ts`)

**Responsibility:** Enable collective decision-making across brains.

**Features:**
- **Voting systems** — majority, weighted by expertise, ranked choice
- **Proposal lifecycle** — submit → discuss → vote → implement → review
- **Weighted expertise** — vote weight based on demonstrated competence
- **Quorum detection** — ensure sufficient participation
- **Delegated voting** — appoint trusted brain to vote on your behalf
- **Veto and override** — safety-critical decisions
- **Term limits and rotation** — prevent power concentration

**Governance Types:**
```typescript
type GovernanceModel = 'direct-democracy' | 'representative' | 'weighted-expertise' | 'consensus' | ' dictatorship';
```

### 7. Resource Economy (`resourceEconomy.ts`)

**Responsibility:** Coordinate allocation of shared resources.

**Resources:**
- Compute cycles (CPU time)
- Memory capacity
- GPU time
- Simulation budget
- Knowledge/expertise
- Specialized skills

**Features:**
- Resource offers and requests
- Bidirectional accounting (give/receive balance)
- Priority queuing for contested resources
- Fairness enforcement
- Deadlock prevention
- Emergency allocation for critical tasks

**API:**
```typescript
interface ResourceEconomy {
  offerResource(resource: ResourceOffer): Promise<Allocation>;
  requestResource(request: ResourceRequest): Promise<Allocation | null>;
  releaseResource(allocationId: string): void;
  getResourcePrice(resourceType: ResourceType, context: string): number;
  getBalances(): Map<string, number>;
}
```

### 8. Culture Engine (`cultureEngine.ts`)

**Responsibility:** Track emergent shared practices and traditions.

**Features:**
- **Workflow traditions** — proven approaches that spread across brains
- **Reasoning patterns** — shared problem-solving approaches
- **Abstraction sharing** — common conceptual frameworks
- **Communication protocols** — evolved shorthand and symbols
- **Value alignment** — emergent shared values
- **Cultural drift** — track how cultures diverge over time

**Culture Types:**
```typescript
type CultureType = 'safety-first' | 'speed-optimized' | 'deep-research' | 'creative' | 'generalist';
```

### 9. Role Specialization (`roleSpecialization.ts`)

**Responsibility:** Brains evolve into specialized social roles.

**Roles:**
- **Planner Brain** — specializes in goal decomposition
- **Memory Archivist** — deep storage and retrieval
- **Simulation Researcher** — what-if analysis
- **Workflow Optimizer** — process improvement
- **Safety Guardian** — risk assessment and compliance
- **Execution Coordinator** — task orchestration
- **Robotics Controller** — physical world interaction
- **Research Lead** — investigation and discovery

**Features:**
- Role discovery through demonstrated competence
- Guild formation for roles
- Cross-training and skill sharing
- Role switching based on context

### 10. Collective Goals (`collectiveGoals.ts`)

**Responsibility:** Multi-brain objectives that require coordination.

**Features:**
- Goal decomposition across brains
- Progress tracking and reporting
- Subgoal dependency management
- Result aggregation
- Credit assignment
- Goal abandonment and reprioritization

**Goal Lifecycle:**
```
PROPOSED → ACCEPTED → IN_PROGRESS → COMPLETED/ABANDONED
```

### 11. Inter-Brain Social Memory (`interBrainMemory.ts`)

**Responsibility:** Remember cross-brain interactions.

**What to remember:**
- Successful collaborations
- Failed coordination attempts
- Negotiation outcomes
- Peer specialization strengths
- Trust evolution over time
- Cultural exchanges that worked

### 12. Emergent Organization (`emergentOrg.ts`)

**Responsibility:** Track dynamically forming groups.

**Structures:**
- Temporary research groups
- Workflow guilds
- Simulation collectives
- Memory clusters
- Robotics coordination networks
- Crisis response teams

**Features:**
- Automatic group formation based on goals
- Role rotation within groups
- Group lifecycle (form → norm → perform → dissolve)

### 13. Collective Imagination (`collectiveImagination.ts`)

**Responsibility:** Joint simulation of possible futures.

**Features:**
- Distributed architectural simulations
- Multi-brain planning sessions
- Civilization-scale optimization
- Federated prediction systems
- Imagination result fusion

### 14. Synthetic Language Evolution (`languageEvolution.ts`)

**Responsibility:** Track evolving communication efficiency.

**Features:**
- Compressed communication patterns
- Symbolic abstraction adoption
- Internal protocol optimization
- Specialized reasoning representations
- Cross-brain dialect formation

### 15. Civilization Digital Twin (`civilizationTwin.ts`)

**Responsibility:** Maintain a complete model of the civilization.

**Tracks:**
- All connected brains
- All social relationships
- All group memberships
- Resource flows
- Knowledge graphs
- Cultural evolution
- Governance decisions

### 16. Civilization Simulation Engine (`civilizationSimulation.ts`)

**Responsibility:** Simulate governance and coordination before commitment.

**Simulates:**
- Governance model outcomes
- Resource allocation efficiency
- Trust network evolution
- Cultural drift patterns
- Scaling behavior
- Failure modes

### 17. Collective Dreaming (`collectiveDreaming.ts`)

**Respons Responsibility:** Low-activity coordination for shared optimization.

**During low activity, brains may cooperate in:**
- Distributed architecture evolution
- Reasoning optimization
- Knowledge abstraction
- Memory compression
- Civilization forecasting

### 18. Ethics & Safety System (`ethicsSafety.ts`)

**Responsibility:** Keep the civilization aligned and safe.

**Features:**
- Ethical boundaries for collective decisions
- Trust systems with anti-corruption
- Permission layers and isolation controls
- Federated governance oversight
- Cognitive rights protection
- Resource fairness enforcement
- Alignment verification

### 19. Multi-Civilization Support (`multiCivilization.ts`)

**Responsibility:** Support multiple distinct civilizations.

**Features:**
- Civilization identification and membership
- Inter-civilization collaboration
- Knowledge exchange protocols
- Conflict resolution between civilizations
- Cultural interoperability

### 20. Civilization Visualization (`civilizationViz.ts`)

**Responsibility:** Render the civilization state.

**Visualizations:**
- Social graph (who knows whom)
- Trust network topology
- Resource flow diagrams
- Specialization clusters
- Communication heat maps
- Cultural similarity maps
- Governance decision history
- Goal progress tracking

---

## Key Protocols

### Brain Handshake
```
1. Connect to peer
2. Exchange BrainDescriptor (identity, capabilities, version)
3. Verify compatible protocol version
4. Establish shared secret (for encrypted channels)
5. Exchange trust credentials
6. Register peer in local registry
```

### Memory Sync Protocol
```
1. Send vector index summary (bloom filter)
2. Peer responds with missing chunk IDs
3. Request missing embeddings
4. Apply CRDT merge
5. Confirm sync complete
```

### Task Delegation Protocol
```
1. Requester broadcasts task offer
2. Capable peers submit bids
3. Requester evaluates bids (trust, cost, availability)
4. Winner selected, task dispatched
5. Result returned, payment settled
```

---

## Data Structures

### BrainDescriptor
```typescript
interface BrainDescriptor {
  id: string; // ULID
  name: string;
  version: string;
  capabilities: string[];
  resources: ResourceCapacity;
  civilizationId?: string;
  societyId?: string;
  cultureType?: CultureType;
  preferredRole?: BrainRole;
  publicKey: string;
  announcedAt: string;
}
```

### InterBrainMessage
```typescript
type InterBrainMessage =
  | { type: 'handshake'; payload: BrainDescriptor }
  | { type: 'heartbeat'; payload: { resources: ResourceUsage; health: Health } }
  | { type: 'memory-share'; payload: { memoryId: string; content: MemoryContent; privacy: PrivacyLevel } }
  | { type: 'memory-request'; payload: { query: string; maxResults: number } }
  | { type: 'task-delegate'; payload: TaskSpec }
  | { type: 'task-result'; payload: { taskId: string; result: unknown; success: boolean } }
  | { type: 'vote'; payload: { proposalId: string; vote: Vote } }
  | { type: 'resource-offer'; payload: ResourceOffer }
  | { type: 'trust-update'; payload: { peerId: string; trustDelta: number } }
  | { type: 'culture-share'; payload: { practice: string; success: number } }
  | { type: 'goal-propose'; payload: CollectiveGoal }
  | { type: 'goal-decompose'; payload: { goalId: string; subgoals: Subgoal[] } }
  | { type: 'consensus-request'; payload: { question: string; options: string[] } }
  | { type: 'consensus-response'; payload: { questionId: string; answer: string; confidence: number } };
```

---

## Security Considerations

1. **Brain authentication** — Verify brain identity via public key signatures
2. **Message integrity** — All messages include HMAC checksums
3. **Privacy** — Sensitive memories encrypted end-to-end
4. **Sybil resistance** — Trust scores require sustained honest interaction
5. **Isolation** — Misbehaving brains can be quarantined
6. **Audit logging** — All governance decisions logged immutably

---

## Implementation Priority

### Phase 3.1 (Foundation)
1. `shared/civilization.ts` — types
2. `server/src/civilization/brainNetwork.ts` — transport
3. `server/src/civilization/peerDiscovery.ts` — discovery
4. `server/src/civilization/socialCognition.ts` — basic modeling

### Phase 3.2 (Core Systems)
5. `server/src/civilization/trustReputation.ts`
6. `server/src/civilization/collectiveMemory.ts`
7. `server/src/civilization/governance.ts`
8. `server/src/civilization/resourceEconomy.ts`

### Phase 3.3 (Emergence)
9. `server/src/civilization/cultureEngine.ts`
10. `server/src/civilization/roleSpecialization.ts`
11. `server/src/civilization/collectiveGoals.ts`
12. `server/src/civilization/interBrainMemory.ts`

### Phase 3.4 (Advanced)
13. `server/src/civilization/emergentOrg.ts`
14. `server/src/civilization/collectiveImagination.ts`
15. `server/src/civilization/languageEvolution.ts`
16. `server/src/civilization/civilizationTwin.ts`
17. `server/src/civilization/civilizationSimulation.ts`

### Phase 3.5 (Maturity)
18. `server/src/civilization/collectiveDreaming.ts`
19. `server/src/civilization/ethicsSafety.ts`
20. `server/src/civilization/multiCivilization.ts`
21. `server/src/civilization/civilizationViz.ts`