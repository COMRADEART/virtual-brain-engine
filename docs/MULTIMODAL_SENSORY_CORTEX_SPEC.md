# Multimodal Sensory Cortex — SPEC

## Overview

The Computer Brain gains **multimodal perception** capabilities, treating the computer screen as its visual field. This document describes the Vision Cortex, Audio Cortex, Spatial Cognition, and their integration with the existing brain infrastructure.

---

## Architecture

### Core Principles

1. **Privacy-first**: All screen capture is explicit, local-only, with user-controlled observation scopes
2. **Local processing**: Vision pipeline runs entirely on-device (no cloud vision APIs)
3. **Incremental integration**: Vision capabilities bolt onto existing Phase 2 architecture without modifying the core pipeline
4. **Minimal dependencies**: Use native OS screen capture + pure Rust/TypeScript image processing

---

## System Components

### 1. Vision Cortex (`server/src/vision/`)

**Responsibilities:**
- Screen capture coordination (via Tauri/Rust)
- Image preprocessing
- OCR (via `rust-persist` or `tesseract` or Ollama vision)
- UI element detection heuristics
- Visual workflow state tracking

**Files:**
```
server/src/vision/
├── index.ts              # Vision cortex boot + event emission
├── capture.ts           # Screen capture coordination (calls Tauri command)
├── ocr.ts               # Text extraction from images
├── uiDetector.ts        # Window/panel/button detection heuristics
├── visualMemory.ts      # Screenshot storage + annotation
├── workflowTracker.ts   # Transition detection between UI states
└── types.ts             # Vision-specific types
```

**Capture Flow:**
1. `captureScreen()` calls Tauri command `capture_screen`
2. Rust returns raw BGRA bytes + dimensions + timestamp
3. TypeScript converts to PNG for storage
4. Optional: OCR pass extracts text
5. Optional: UI detection identifies windows/regions
6. Events emitted to brain bus

### 2. Rust Screen Capture (`src-tauri/src/screen_capture.rs`)

**Tauri Commands:**
- `capture_screen(monitor_index: Option<u32>)` → `ScreenCaptureResult`
- `get_monitors()` → `Vec<MonitorInfo>`
- `start_streaming(callback_url: String)` → stream ID
- `stop_streaming(stream_id: String)`

**Implementation:**
- Use `screenshots` crate on Windows for efficient capture
- Return raw BGRA pixel buffer + metadata
- Support primary monitor or specific monitor index

### 3. Visual Memory Storage

**New SQLite tables:**
```sql
CREATE TABLE visual_memory (
  id TEXT PRIMARY KEY,
  screenshot_path TEXT NOT NULL,  -- path to PNG in data/visual/
  thumbnail_path TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  capture_timestamp INTEGER NOT NULL,
  source_app TEXT,                -- detected application name
  window_title TEXT,
  monitor_index u8,
  hash TEXT NOT NULL,             -- for deduplication
  tags TEXT,                      -- JSON array of tags
  annotation TEXT,                -- human annotation
  linked_memory_ids TEXT,         -- JSON array of linked MemoryPoint IDs
  created_at INTEGER NOT NULL
);

CREATE TABLE visual_regions (
  id TEXT PRIMARY KEY,
  visual_memory_id TEXT NOT NULL,
  region_type TEXT NOT NULL,      -- 'window' | 'panel' | 'button' | 'text' | 'diagram' | 'terminal' | 'unknown'
  bounding_box_x REAL NOT NULL,
  bounding_box_y REAL NOT NULL,
  bounding_box_width REAL NOT NULL,
  bounding_box_height REAL NOT NULL,
  confidence REAL NOT NULL,
  detected_text TEXT,
  detected_app TEXT,
  metadata TEXT,                  -- JSON for type-specific data
  created_at INTEGER NOT NULL,
  FOREIGN KEY (visual_memory_id) REFERENCES visual_memory(id)
);

CREATE TABLE visual_workflow_states (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entry_screenshot_id TEXT,
  exit_screenshot_id TEXT,
  transition_trigger TEXT,
  frequency INTEGER DEFAULT 1,
  avg_duration_ms INTEGER,
  tags TEXT,
  created_at INTEGER NOT NULL
);
```

**Storage layout:**
```
data/visual/               # Screenshots (gitignored)
data/visual/thumbnails/    # Smaller previews
data/visual/regions/       # Cropped region images
```

### 4. Visual Knowledge Graph Integration

**Shared types in `shared/vision.ts`:**
```typescript
interface VisualKnowledgeNode {
  id: string;
  type: 'window' | 'panel' | 'button' | 'text_region' | 'diagram' | 'terminal' | 'workflow';
  app: string;
  position: { x: number; y: number; width: number; height: number };
  text?: string;
  children?: string[];  // child node IDs
  parent?: string;      // parent node ID
  captureId: string;    // link to visual_memory
  timestamp: number;
}

interface VisualKnowledgeEdge {
  source: string;       // VisualKnowledgeNode ID
  target: string;
  relation: 'contains' | 'overlaps' | 'follows' | 'triggers' | 'associated_with';
  weight: number;        // 0-1 confidence
}

interface VisualKnowledgeGraph {
  nodes: Map<string, VisualKnowledgeNode>;
  edges: VisualKnowledgeEdge[];
  lastCaptureId: string;
  activeWindowId?: string;
}
```

### 5. Vision Agents

**New agents in `server/src/agents/`:**

#### VisionAgent (`visionAgent.ts`)
- Subscribes to screen capture events
- Triggers OCR on new captures
- Maintains visual memory index
- Emits `visual-memory-created` events

#### ScreenTrackingAgent (`screenTrackingAgent.ts`)
- Tracks active window changes
- Detects workflow transitions (same sequence of windows)
- Maintains digital environment model
- Emits `window-changed`, `workflow-detected` events

#### UIReasoningAgent (`uiReasoningAgent.ts`)
- Analyzes captured screens for UI patterns
- Detects: build failures, error dialogs, IDE panels, browser tabs
- Triggers contextual memory retrieval based on visual context
- Emits `ui-state-detected` events

### 6. WebSocket Events (BrainBus)

**New `BrainBusMessage` variants:**
```typescript
type BrainBusMessage =
  | { type: 'screen-captured'; capture: ScreenCapture }
  | { type: 'visual-memory-created'; memory: VisualMemory }
  | { type: 'visual-regions-detected'; regions: VisualRegion[] }
  | { type: 'window-changed'; info: WindowInfo }
  | { type: 'workflow-detected'; workflow: VisualWorkflowState }
  | { type: 'ui-state-detected'; state: UIState }
  | { type: 'visual-knowledge-updated'; graph: VisualKnowledgeGraph }
  | { type: 'visual-query-result'; results: VisualSearchResult[] }
```

### 7. API Routes

**New routes:**
```
GET  /api/vision/capture          # Trigger immediate capture
GET  /api/vision/memories         # List visual memories (paginated)
GET  /api/vision/memories/:id     # Get specific visual memory + regions
DELETE /api/vision/memories/:id   # Delete visual memory
POST /api/vision/query            # Query visual memory (text or image similarity)
GET  /api/vision/workflow/:id      # Get workflow history
GET  /api/vision/active-window    # Get current active window info
GET  /api/vision/environment      # Get digital environment model
```

### 8. Frontend Components (`src/components/`)

**New:**
```
src/components/vision/
├── VisionCortexPanel.tsx    # Main panel showing visual cortex state
├── ScreenView.tsx           # Live/recent screenshot view
├── VisualMemoryGrid.tsx     # Grid of visual memories
├── UIElementOverlay.tsx     # Detected UI elements overlaid on screenshot
├── WorkflowTimeline.tsx    # Visual workflow history
└── VisionSettings.tsx       # Capture settings (frequency, scope, privacy)
```

**New engine files:**
```
src/engine/
├── visualKnowledgeGraph.ts  # Client-side visual KG management
├── screenObserver.ts        # Subscribes to vision WS events
└── visualCortex.ts          # Vision state management (outside React)
```

### 9. Privacy Controls

**Configuration options:**
- `visionEnabled: bool` — master toggle
- `captureIntervalMs: u32` — minimum time between captures (0 = manual only)
- `observationScope: 'all' | 'specific-apps' | 'exclude-apps'` — app allowlist/blocklist
- `privateWindows: bool` — exclude windows with "private" in title
- `maxMemoryAge: u32` — auto-delete visual memories older than N days
- `requireExplicitCapture: bool` — disable automatic capture entirely

**Privacy indicators:**
- LocalityBadge extends to show vision status
- Frontend shows "eye" icon when vision is active
- System tray notification on first capture after inactivity

---

## Implementation Phases

### Phase 1: Foundation (This PR)
1. Rust screen capture in `src-tauri/src/screen_capture.rs`
2. Vision cortex server boot in `server/src/vision/index.ts`
3. Basic capture API: `GET /api/vision/capture`
4. Visual memory storage (SQLite + PNG files)
5. Tauri commands wired up
6. Frontend `VisionCortexPanel` skeleton

### Phase 2: OCR + UI Detection
1. OCR integration (Ollama vision or `tesseract` CLI)
2. UI element detection heuristics
3. Window tracking (active window name)
4. `visual-regions-detected` events

### Phase 3: Visual Memory + Knowledge Graph
1. Visual memory search (by text, by similarity, by app)
2. Visual knowledge graph building
3. Linked memory connections
4. `visual-knowledge-updated` events

### Phase 4: Workflow Perception
1. Workflow state detection
2. Transition tracking
3. `workflow-detected` events
4. Workflow timeline frontend

### Phase 5: UI Reasoning
1. Pattern detection (build failures, errors, IDE panels)
2. Contextual brain triggers
3. Integration with organism/swarm

### Phase 6: Audio Cortex (Future)
- Speech recognition (system audio or mic)
- Notification interpretation
- Audio event detection

---

## Key Files to Create/Modify

### New files
```
src-tauri/src/screen_capture.rs    # Rust screen capture
server/src/vision/                 # Vision cortex module
server/src/agents/visionAgent.ts
server/src/agents/screenTrackingAgent.ts
server/src/agents/uiReasoningAgent.ts
server/src/routes/vision.ts
shared/vision.ts                   # Vision types
src/components/vision/             # Frontend components
src/engine/visualKnowledgeGraph.ts
src/engine/screenObserver.ts
src/engine/visualCortex.ts
```

### Modified files
```
src-tauri/src/lib.rs              # Register screen_capture module
src-tauri/src/commands.rs           # Add capture commands
src-tauri/tauri.conf.json          # Add required permissions
server/src/index.ts                # Boot vision cortex
server/src/db/schema.sql           # Add visual_memory tables
shared/pipeline.ts                 # Add vision BrainBusMessage variants
src-tauri/Cargo.toml               # Add screenshots crate dependency
server/src/routes/index.ts         # Mount vision router
```

---

## Dependencies

**Rust (src-tauri/Cargo.toml):**
```toml
screenshots = "0.8"   # Cross-platform screen capture
image = "0.25"         # Image processing
```

**Optional (server/package.json):**
- `tesseract.js` — pure JS OCR (works without external binary)
- Or use Ollama with vision model for OCR

**No new system dependencies** for Phase 1.

---

## Privacy Implementation

1. **Explicit permission**: Vision capture only starts after user enables it in settings
2. **Observation scope**: Per-app allowlist/blocklist stored in config
3. **Private window exclusion**: Windows with "private", "incognito", "secret" in title are skipped
4. **Local-only**: All processing happens on-device, no cloud APIs
5. **Secure storage**: Visual memories in `data/visual/` (gitignored)
6. **Encryption at rest**: Optional - screenshots encrypted with user key
7. **User-controlled deletion**: All visual memories can be deleted individually or in bulk
8. **Audit trail**: All captures logged to `agent_audit` table