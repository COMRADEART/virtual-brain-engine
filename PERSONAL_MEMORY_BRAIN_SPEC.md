# Personal Memory Brain - Technical Specification

## 1. Concept & Vision

The Personal Memory Brain transforms the 3D brain visualization from a passive display into an **active AI companion with persistent memory**. When you chat with the AI, you literally see it "think" — neurons fire, pathways activate, and specific brain regions light up as memories are retrieved and processed. The brain becomes a window into your AI's mind.

**Core philosophy**: Local-first, private AI with visual memory awareness. Your data never leaves your machine. The visualization makes the AI's reasoning transparent and debuggable.

---

## 2. Design Language

### Aesthetic Direction
Cyberpunk neural interface meets medical imaging. Deep space blacks with electric cyan synapses, warm amber memory retrieval flashes, and cool blue-white neural pathways. Think: TRON meets neuroscience textbook.

### Color Palette
```
--bg-primary: #0a0a0f (deep space black)
--bg-secondary: #12121a (panel background)
--bg-tertiary: #1a1a24 (elevated surfaces)
--accent-cyan: #00d4ff (synapses, pathways, active)
--accent-amber: #ffb347 (memory retrieval, hippocampus)
--accent-green: #00ff88 (successful connections)
--accent-red: #ff4757 (errors, uncertainty)
--accent-purple: #a855f7 (reasoning, prefrontal)
--text-primary: #e8e8f0
--text-secondary: #8888a0
--text-muted: #555566
```

### Typography
- **Primary**: JetBrains Mono (monospace, technical feel)
- **Display**: Orbitron (futuristic headers)
- **Fallback**: ui-monospace, monospace

### Spatial System
- 8px base grid
- 4px minimum spacing
- Panel border-radius: 12px
- Glass-morphism on overlays: `backdrop-filter: blur(16px)`

### Motion Philosophy
- **Neural pulses**: Continuous, physics-based with slight randomization
- **Memory retrieval**: Sharp amber flash → slow cyan fade (memory access pattern)
- **Region activation**: Smooth glow intensity ramping over 200ms
- **Chat messages**: Slide-in from bottom, 150ms ease-out
- **Think mode**: Dramatic pulse waves emanating from hippocampus

---

## 3. Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (React + Three.js)             │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────┐  │
│  │AskPanel │  │ BrainScene│  │MemoryDash│  │ StatusPanel │  │
│  │(Chat UI)│  │(3D Brain) │  │(Stats)   │  │ (Stats)     │  │
│  └────┬────┘  └─────┬────┘  └────┬────┘  └──────┬───────┘  │
│       │             │            │               │          │
│       └─────────────┴────────────┴───────────────┘          │
│                          │                                    │
│              ┌───────────▼───────────┐                       │
│              │    BrainBus (WS)     │                       │
│              │  + SignalSimulation  │                       │
│              └───────────────────────┘                       │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP/WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│                   BACKEND (Express + TypeScript)             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ OllamaSvc   │  │ MemoryEngine │  │ ReasoningPipeline │   │
│  │ (chat/embed)│  │ (sqlite-vec) │  │ (7-step + Think)  │   │
│  └─────────────┘  └──────────────┘  └───────────────────┘   │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ Scanner     │  │ Conversations│  │ MemoryManager     │   │
│  │ (file idx)  │  │ (history)    │  │ (importance/forge)│   │
│  └─────────────┘  └──────────────┘  └───────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │  sqlite-vec (vectors)   │
              │  + SQLite (relations)  │
              └─────────────────────────┘
```

---

## 4. Core Data Model

### Memory Types
```typescript
interface MemoryPoint {
  id: string;              // ULID
  content: string;         // Full text
  contentHash: string;     // SHA1 for dedup
  embedding: number[];     // 768 or 1024 dim vector
  embeddingModel: string;  // Which model produced it

  // Memory classification
  memoryType: 'episodic' | 'semantic' | 'procedural' | 'working';
  brainRegion: LogicalRegionId;  // Which region "stores" it

  // Importance tracking
  importance: number;      // 0.0 - 1.0, computed from access patterns
  accessCount: number;     // How many times retrieved
  lastAccessedAt: string;  // ISO timestamp
  createdAt: string;       // ISO timestamp

  // Forgetting system
  decayScore: number;      // Computed importance decay over time
  summaryId?: string;     // Link to summarized version if merged

  // Source tracking
  sourceType: 'conversation' | 'file' | 'note' | 'manual';
  sourcePath?: string;    // File path if from file
  projectName?: string;   // Project context
  metadata: Record<string, unknown>;
}

interface MemoryRelation {
  id: string;
  fromId: string;
  toId: string;
  relationType: 'cites' | 'contradicts' | 'elaborates' | 'reminds' | 'belongs-to';
  strength: number;         // 0.0 - 1.0
  createdAt: string;
}
```

### Logical Brain Regions (already defined, enhanced)
```typescript
type LogicalRegionId =
  | 'memory-core'        // Hippocampus: episodic/personal memories
  | 'reasoning-cortex'   // Prefrontal: planning, reasoning
  | 'project-cortex'     // Parietal: spatial, project context
  | 'file-memory'         // Temporal: file-based knowledge
  | 'model-hub'           // Thalamus: model routing
  | 'response-center'    // Motor: output generation
  | 'error-detection'    // Amygdala: uncertainty, errors
  | 'learning-feedback'   // Cerebellum: learning from results
  | 'working-memory';     // NEW: active conversation context
```

### Retrieval Event (new)
```typescript
interface RetrievalEvent {
  memoryId: string;
  score: number;           // Vector similarity 0-1
  retrievalType: 'exact' | 'associative' | 'temporal' | 'semantic';
  brainRegion: LogicalRegionId;
  activationStrength: number;  // How bright to flash the region
  thoughtProcess?: string;     // Why this memory was retrieved
}
```

---

## 5. Feature Specifications

### 5.1 Enhanced Chat Interface (AskPanel 2.0)

**Layout**:
```
┌────────────────────────────────────────────────────────────┐
│ [Brain OS]  Personal Memory Brain    [Memory: 1,247] [⚡] │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              3D Brain Scene (40% height)              │  │
│  │         [Brain regions light up during chat]         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌─ Retrieved Memories ─────────────────────────────────┐  │
│  │ 🧠 [Hippocampus] Memory from 2 days ago     [0.94]   │  │
│  │ 📄 [Temporal] Code from src/engine/...    [0.87]     │  │
│  │ 💭 [Prefrontal] Previous reasoning...     [0.72]     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌─ Chat ────────────────────────────────────────────────┐  │
│  │ You: How does the signal simulation work?            │  │
│  │                                                       │  │
│  │ Brain: The signal simulation uses... [m:abc123]       │  │
│  │        Based on [m:def456], it...                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌─ Input ───────────────────────────────────────────────┐  │
│  │ [Think Mode 🔥] [Drop files here]        [Send ➤]     │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**Think Mode**:
When user clicks "Think" button:
1. Brain sends message to `/api/ask` with `thinkMode: true`
2. Pipeline runs enhanced retrieval: deep memory search with multiple passes
3. Brain pulses dramatically from hippocampus outward
4. All retrieved memories shown with citation chips before response
5. Response is grounded in specific memories

**Drag & Drop**:
- Drop files/folders onto the chat area
- Files are scanned, chunked, embedded, stored
- Brain shows "file memory" region activating during processing

### 5.2 Memory-Aware Brain Visualization

**During Normal Chat**:
- Active brain region glows based on current pipeline step
- Pulses travel along pathways connecting regions
- Intensity proportional to region involvement

**During Memory Retrieval** (NEW):
- Specific memories map to specific neurons within regions
- When memory from file X is retrieved, specific neurons in temporal lobe flash amber
- Retrieval strength shown as neuron brightness (0.0 - 1.0)
- Pathway activation shows "reasoning path" through connected memories

**Think Mode Activation**:
- Massive synchronized pulse wave from hippocampus
- Sequential activation: hippocampus → reasoning cortex → project cortex
- Shows memory-to-memory pathway traversal

**Visual Encoding**:
```
Memory Neuron States:
- Dormant: Region base color at 20% brightness
- Accessing: Amber flash, 80% brightness
- High relevance: Cyan glow, 100% brightness + bloom
- Working memory: Purple glow, pulsing

Pathway States:
- Idle: 10% opacity, thin
- Active: 60% opacity, medium, color based on signal type
- Think mode: 100% opacity, thick, pulse waves traveling along
```

### 5.3 Smart Memory Management

**Importance Scoring**:
```typescript
function computeImportance(memory: MemoryPoint): number {
  const recencyWeight = 0.2;
  const accessWeight = 0.3;
  const relationWeight = 0.3;
  const sourceWeight = 0.2;

  const recency = Math.exp(-daysSinceAccess / 30);  // Decay over 30 days
  const access = Math.min(memory.accessCount / 100, 1.0);
  const relations = getRelationCount(memory.id) / 50;
  const sourceBoost = memory.sourceType === 'conversation' ? 0.8 : 0.5;

  return (
    recencyWeight * recency +
    accessWeight * access +
    relationWeight * relations +
    sourceWeight * sourceBoost
  );
}
```

**Forgetting System**:
- Memories with importance < 0.1 and age > 90 days are candidates
- Background job runs weekly to:
  1. Summarize groups of related old memories
  2. Replace multiple old memories with one summarized version
  3. Mark original as `decayed: true, summaryId: newId`

**Memory Dashboard**:
```
┌─ Memory Brain Status ──────────────────────────────────────┐
│                                                             │
│  Total Memories: 1,247     Storage: 42 MB                  │
│  This Week: +89 / -12       Compression: 94%                │
│                                                             │
│  ┌─ By Brain Region ─────────────────────────────────────┐ │
│  │ 🧠 Memory Core (Hippocampus)     423 memories  [=====] │ │
│  │ 📚 File Memory (Temporal)        512 memories  [======] │ │
│  │ 🧩 Reasoning (Prefrontal)        156 memories  [===]   │ │
│  │ ⚙️ Working Memory               89 memories   [==]    │ │
│  │ 🎯 Project Context (Parietal)   67 memories   [=]     │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Health ──────────────────────────────────────────────┐ │
│  │ Connections: 3,421    Avg Importance: 0.47            │ │
│  │ Forgotten (90d): 23   Summarized: 8                  │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  [🔄 Run Maintenance]  [📊 Export Memory]  [🗑️ Clear Old]   │
└─────────────────────────────────────────────────────────────┘
```

### 5.4 Conversation & Memory Linking

**Every conversation becomes a memory**:
1. After each conversation turn, content is embedded and stored
2. Memories are linked with `cites` relations based on citation markers
3. Conversation context stored in `working-memory` region

**Memory Citations**:
- When AI cites `[m:abc123]`, that memory's neurons glow during display
- Clicking a citation highlights the memory in the retrieved memories panel
- High citation count = high relation strength = higher importance

---

## 6. Backend API Changes

### New Endpoints

```typescript
// Think Mode - Deep memory retrieval before response
POST /api/ask
Body: { prompt: string, conversationId?: string, thinkMode?: boolean }
Response: SSE<PipelineEvent>

// Enhanced retrieval with reasoning trace
GET /api/memory/retrieve?query=...&mode=deep|fast&limit=20
Response: {
  hits: Array<{
    memory: MemoryPoint;
    retrievalType: 'exact' | 'associative' | 'temporal';
    thoughtProcess: string;  // Why this was retrieved
    brainRegion: LogicalRegionId;
    activationStrength: number;
  }>;
}

// Memory maintenance
POST /api/memory/maintenance
Response: { consolidated: number, forgotten: number, errors: string[] }

// Memory stats
GET /api/memory/stats
Response: {
  total: number;
  byRegion: Record<LogicalRegionId, number>;
  byType: Record<MemorySourceType, number>;
  avgImportance: number;
  storageBytes: number;
  forgottenCount: number;
}

// File drop upload
POST /api/memory/ingest
Body: FormData with files
Response: { processed: number, memories: number, errors: string[] }

// Region memories
GET /api/memory/region/:regionId
Response: { memories: MemoryPoint[] }

// Conversation with memory context
POST /api/conversations
Body: { title?: string }
Response: { conversation: Conversation }

// Think about this
POST /api/conversations/:id/think
Body: { prompt: string }
Response: SSE with deep retrieval events

// Memory detail with neighbors
GET /api/memory/:id/graph
Response: {
  memory: MemoryPoint;
  relations: Array<{ to: MemoryPoint; relationType: string; strength: number }>;
  accessHistory: Array<{ accessedAt: string; retrievalType: string }>;
}
```

### Enhanced Pipeline Events

```typescript
// New event types for memory retrieval visualization
interface RetrievalEvent extends PipelineEvent {
  step: 'retrieval';
  status: 'start' | 'progress' | 'complete';
  hits: Array<{
    memoryId: string;
    score: number;
    brainRegion: LogicalRegionId;
    activationStrength: number;
    thoughtProcess?: string;
  }>;
  totalHits: number;
}

interface ThinkModeEvent extends PipelineEvent {
  step: 'think';
  status: 'deep-retrieval' | 'reasoning' | 'synthesizing';
  activations: Array<{
    region: LogicalRegionId;
    intensity: number;
    memoryIds: string[];
  }>;
}
```

---

## 7. Frontend Component Changes

### Modified Components

1. **AskPanel.tsx** → Enhanced with:
   - Retrieved memories panel
   - Think mode toggle
   - Drag & drop zone
   - Citation chips with memory preview
   - Streaming response with highlighted citations

2. **BrainScene.tsx** → Enhanced with:
   - Memory-specific neuron groups
   - Retrieval event handling
   - Think mode dramatic visualization
   - Memory region highlight mode

3. **SignalSimulation.ts** → Enhanced with:
   - `addRetrievalPulse(memoryId, strength, region)` method
   - Think mode synchronized wave generation
   - Memory-to-memory pathway tracing

4. **MemoryDashboard.tsx** → New component:
   - Memory statistics
   - Region breakdown
   - Maintenance actions

5. **StatusPanel.tsx** → Enhanced with:
   - Memory count badge
   - Think mode indicator
   - Last retrieval summary

### New Components

1. **MemoryRetrievalPanel.tsx** - Shows retrieved memories with scores
2. **ThinkModeOverlay.tsx** - Dramatic think mode visualization
3. **MemoryCitationChip.tsx** - Clickable memory citation
4. **DropZone.tsx** - File/folder drag & drop handling
5. **MemoryHealthGauge.tsx** - Visual memory statistics

---

## 8. Database Schema Changes

### New Tables

```sql
-- Enhanced memory tracking
CREATE TABLE memory_decay_log (
  id TEXT PRIMARY KEY,
  memory_id TEXT REFERENCES memory_points(id),
  decay_score REAL,
  reason TEXT,
  created_at TEXT
);

-- Think mode sessions
CREATE TABLE think_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  started_at TEXT,
  ended_at TEXT,
  retrieval_passes INTEGER,
  memories_analyzed INTEGER
);

-- Memory access patterns
CREATE TABLE memory_access_log (
  id TEXT PRIMARY KEY,
  memory_id TEXT REFERENCES memory_points(id),
  session_id TEXT,
  retrieval_type TEXT,
  relevance_score REAL,
  accessed_at TEXT
);

-- Memory summaries (for forgetting)
CREATE TABLE memory_summaries (
  id TEXT PRIMARY KEY,
  original_ids TEXT,  -- JSON array of memory IDs that were summarized
  summary_content TEXT,
  created_at TEXT,
  importance REAL
);
```

### New Indexes

```sql
-- Fast region-based queries
CREATE INDEX idx_memory_region ON memory_points(brain_region);
CREATE INDEX idx_memory_decay ON memory_points(decay_score);
CREATE INDEX idx_memory_access ON memory_access_log(memory_id, accessed_at);
```

---

## 9. Key Implementation Files

### Backend (server/src/)

| File | Purpose | Change Type |
|------|---------|-------------|
| `reasoning/pipeline.ts` | 7-step + think mode | Modify |
| `reasoning/retrieval.ts` | Enhanced memory retrieval | New |
| `memory/manager.ts` | Importance decay, forgetting | New |
| `memory/summarizer.ts` | Memory consolidation | New |
| `routes/memory.ts` | Enhanced memory API | Modify |
| `routes/ask.ts` | Think mode SSE | Modify |
| `db/repositories/memory.ts` | Vector + SQL queries | Modify |
| `db/schema.sql` | New tables | Modify |

### Frontend (src/)

| File | Purpose | Change Type |
|------|---------|-------------|
| `components/AskPanel.tsx` | Enhanced chat UI | Modify |
| `components/BrainScene.tsx` | Memory visualization | Modify |
| `engine/signalSimulation.ts` | Retrieval pulses | Modify |
| `engine/memoryMapper.ts` | Memory→neuron mapping | New |
| `components/MemoryDashboard.tsx` | Memory stats UI | New |
| `components/MemoryRetrievalPanel.tsx` | Retrieved memories | New |
| `components/DropZone.tsx` | File drag/drop | New |
| `components/ThinkModeOverlay.tsx` | Think mode effects | New |

---

## 10. Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Database schema updates (new tables, indexes)
- [ ] Enhanced memory API endpoints
- [ ] Think mode backend implementation
- [ ] Memory retrieval with reasoning trace
- [ ] Basic memory statistics endpoint

### Phase 2: Visualization (Week 2-3)
- [ ] Retrieval event handling in BrainScene
- [ ] Memory-specific neuron groups
- [ ] Think mode dramatic visualization
- [ ] SignalSimulation retrieval pulses
- [ ] Memory citation chips

### Phase 3: Intelligence (Week 3-4)
- [ ] Importance scoring implementation
- [ ] Forgetting system (background job)
- [ ] Memory summarization
- [ ] Maintenance API
- [ ] Memory health dashboard

### Phase 4: UX Polish (Week 4-5)
- [ ] Drag & drop file ingestion
- [ ] AskPanel enhancements
- [ ] Think mode toggle UI
- [ ] Memory status panel
- [ ] Error handling & edge cases

---

## 11. Performance Targets

- Chat response: < 200ms first token (excluding Ollama)
- Memory retrieval: < 50ms for 1000 memories
- Brain visualization: Maintain 60 FPS during animations
- File ingestion: 100MB/minute processing
- Memory search: < 100ms for k=20 nearest neighbors
- Startup: < 3 seconds to interactive brain

---

## 12. Testing Strategy

### Smoke Tests
- `verify:canvas` - 3D scene renders
- `test:actions` - All UI interactions work
- `/api/health` - Backend healthy
- `/api/ask` - Basic chat works

### New Tests
- `test:retrieval` - Memory retrieval accuracy
- `test:forgetting` - Importance decay works
- `test:citations` - Citations appear correctly
- `test:think-mode` - Deep retrieval works
- `test:ingest` - File drop creates memories