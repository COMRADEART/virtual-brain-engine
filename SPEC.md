# Virtual Brain Engine — Technical Specification

> **Status:** Phase 2 in progress. Phase 1 (visualizer + 7-step pipeline + SQLite memory) is shipped.
> **Owner:** Raviteja Allamsetti
> **Last updated:** 2026-05-21

---

## 1. Project Overview

The **Virtual Brain Engine** is a local-first, interactive 3D visualization of an artificial cognitive system. It renders a biologically-inspired brain in real time and binds each anatomical region to a concrete software subsystem — memory retrieval, reasoning, error detection, learning, and so on. When the underlying AI executes a thought, the corresponding regions light up, pathways pulse, and the user can literally watch the system think.

It is simultaneously three things:

1. **A working local AI.** A 7-step reasoning pipeline backed by SQLite + `sqlite-vec`, an Ollama (or OpenAI-compatible) connector, a learned ranker, a memory ML layer, an agentic runtime, and a digital twin of the host system.
2. **A real-time visualizer.** A Three.js scene driven by a deterministic signal-propagation simulation, fed by live events from the pipeline over WebSocket + SSE.
3. **A research surface for cognitive architecture.** Phase 2 organism subsystems (evolution, imagination, swarm, organism) let us experiment with self-modifying behavior in a constrained, observable environment.

### 1.1 Goals

- **Local-first by default.** Zero outbound traffic out of the box. Allowlist-enforced server-side. Loopback-only LLM runtimes.
- **Glass-box cognition.** Every reasoning step is observable in the 3D scene and on a structured event stream. There is no hidden state.
- **60 FPS, always.** The renderer must sustain interactive frame rates even at the highest neuron density tier, on commodity hardware.
- **Composable cognition.** Logical regions (memory, reasoning, response, learning, …) map cleanly onto code modules and onto anatomical regions in the visual.
- **Deterministic where it counts.** Graph generation, pulse spawning, and simulation use seeded RNG so behavior is reproducible.

### 1.2 Non-Goals

- Cloud deployment, multi-tenant operation, or per-user accounts.
- Biological accuracy beyond what serves comprehension. Region mappings are evocative, not anatomically rigorous.
- Replacing a frontier model. This system augments small local models with memory, retrieval, and reasoning scaffolding — it does not claim parity with hosted LLMs.

---

## 2. Brain Region ↔ AI Subsystem Mapping

The codebase carries **two parallel taxonomies** (see `CLAUDE.md → Architecture → The two layers the brain visualises`):

- **Logical regions** (8 cortices) — defined in `shared/pipeline.ts`. Emitted by the server in every `PipelineEvent`.
- **Anatomical regions** (~30 IDs) — defined in `src/engine/types.ts` and `src/data/regionDefinitions.ts`. Rendered in the 3D scene.

The mapping between them lives in `src/engine/logicalRegions.ts` (`LOGICAL_REGION_MAP`). The table below is the canonical view.

| Logical Region (`LogicalRegionId`) | Anatomical Regions That Light Up | AI Subsystem | Code Surface |
|---|---|---|---|
| `memory-core` | Hippocampus, entorhinal cortex, parahippocampal gyrus | Vector retrieval, recency/importance boosting, memory lifecycle, consolidation | `server/src/db/repositories/memory.ts`, `server/src/memory/*`, `sqlite-vec` |
| `reasoning-cortex` | Prefrontal cortex (dorsolateral, ventromedial), anterior cingulate | JSON plan synthesis, multi-step reasoning, learned re-ranking | `server/src/reasoning/pipeline.ts` (step 3), `reasoning/ranker.ts` |
| `project-cortex` | Posterior parietal, precuneus | Project-name re-ranking, context grouping | `server/src/reasoning/pipeline.ts` (step 4) |
| `file-memory` | Temporal lobe (lateral + inferior), fusiform | File-system scanner, chunker, file→memory indexer | `server/src/scanner/*` |
| `model-hub` | Thalamus, basal ganglia | Connector registry, runtime discovery, embedding fallback chain | `server/src/connectors/*` |
| `response-center` | Broca's area, motor cortex, supplementary motor area | Streamed answer generation, citation validation, three-section response (Known / Inferred / Uncertain) | `server/src/reasoning/pipeline.ts` (step 6), `prompts.ts` |
| `error-detection-center` | Anterior cingulate, insula | Contradiction detection, missing-evidence flags, confidence scoring | `server/src/reasoning/pipeline.ts` (step 5) |
| `learning-feedback-center` | Cerebellum, hippocampus (write-side) | Persisting Q+A as `MemoryPoint`, linking to cited memories, importance re-scoring | `server/src/reasoning/pipeline.ts` (step 7), `memory/importanceScorer.ts` |

> Adding a new logical region requires touching **both** `shared/pipeline.ts` (the `LogicalRegionId` union + `LOGICAL_REGION_IDS` list) **and** `src/engine/logicalRegions.ts` (`LOGICAL_REGION_MAP` + labels). Adding a new anatomical region requires `src/engine/types.ts`, `src/data/regionDefinitions.ts`, and the `REGION_CONNECTIONS` adjacency list in `src/engine/brainRegions.ts`.

### 2.1 Extended Subsystems (Phase 2)

| Subsystem | Surfaced At | Region Affinity (visual) |
|---|---|---|
| Digital Twin | `/api/twin` | Insula, somatosensory cortex (proprioception of the host machine) |
| Swarm | `/api/swarm` | Distributed cortical activation (multi-region flash) |
| Imagination | `/api/imagination` | Default mode network — medial PFC, posterior cingulate |
| Evolution | `/api/evolution` | Cerebellum + basal ganglia (skill acquisition) |
| Organism | `/api/organism` | Brainstem + hypothalamus (homeostasis) |
| Agentic Runtime | in-process (`agents/`) | Frontal pole (orchestration) |

---

## 3. System Architecture

### 3.1 Process Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Tauri Desktop Shell (optional)              │
│                         src-tauri/  ·  Rust 2 + WebView             │
└─────────────────────────────────────────────────────────────────────┘
                                   │ wraps
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Vite + React + Three.js Frontend           src/                    │
│  ─────────────────────────────────                                  │
│  App.tsx ─┬─ BrainScene ── NeuralGraphRenderer ── SignalSimulation  │
│           ├─ BrainOS panels (Compact / Focus / CommandPalette)      │
│           ├─ AskPanel ──── /api/ask (SSE)                           │
│           ├─ PipelineOverlay                                        │
│           └─ brainBus (WS /ws/brain)                                │
└────────────────────────────────────┬────────────────────────────────┘
                                     │ HTTP /api/*  +  WS /ws/brain
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Node Server                       server/   ·  127.0.0.1:8787      │
│  ───────────                                                        │
│  Express ─┬─ /api/health  /api/memory  /api/scan  /api/connectors   │
│           ├─ /api/conversations  /api/ask (SSE)                     │
│           ├─ /api/twin  /api/swarm  /api/imagination                │
│           ├─ /api/evolution  /api/organism                          │
│           └─ /ws/brain (broadcast PipelineEvent)                    │
│                                                                     │
│  Reasoning Pipeline (7 steps)  ──► emitAll() ──► SSE + WS           │
│  Memory ML layer · Learned Ranker · Agents · Twin · Phase 2 cores   │
└────────────────────────────────────┬────────────────────────────────┘
                                     │
                ┌────────────────────┼──────────────────────┐
                ▼                    ▼                      ▼
        SQLite + sqlite-vec   Local LLM Runtime      Filesystem
        data/brain.sqlite     (Ollama / LM Studio /  (scanned by
                              llama.cpp / Jan /      walker/chunker)
                              GPT4All / vLLM / TGI)
```

### 3.2 Module Boundaries

- **`shared/`** — pure-TypeScript type contracts. **Zero runtime dependencies.** Imported by both the Vite client and the Node server without a build step. Owns `pipeline.ts`, `memory.ts`, `connector.ts`, plus Phase 2 contracts (`twin.ts`, `swarm.ts`, `evolution.ts`, `imagination.ts`, `organism.ts`, `phase2.ts`).
- **`src/engine/`** — non-React rendering and simulation core. Holds mutable Float32Arrays for per-frame state. Never lifted into React.
- **`src/components/`** — React components. Own *config*, not per-frame state. Route config changes through `simulation.setX(...)` methods on the engine.
- **`server/src/reasoning/`** — the 7-step pipeline. The single source of truth for what counts as "a thought."
- **`server/src/memory/`** — the memory ML layer. Narrow seam into the pipeline: only `onConversationMessage` / `processNewMemory` / `updateMemoryImportance` are called from `reasoning/pipeline.ts`. Everything else is a library that those entry points pull from.
- **`server/src/core/`** — Phase 2 subsystems (evolution, imagination, organism, swarm, safety) and the event bus. Each has its own router; experimental surface stays behind those routers, not inside the pipeline.
- **`crates/`** — 7 Rust crates consumed only by `src-tauri/`. **No root `Cargo.toml`.** Not a standalone workspace.
- **`computer-brain/`** — a *separate*, self-contained Cargo workspace (28 crates + its own Tauri app). Architectural cousin, not shared code.

### 3.3 Rendering vs. React Boundary (Core Design Choice)

The simulation state — `regionIntensity`, `pathwayIntensity`, and the `pulses` array on `SignalSimulation` — is **deliberately held outside React** as mutable Float32Arrays / a mutable array.

- React owns *config* (selected action, speed, density, visibility, shell opacity, camera preset).
- The render loop in `BrainScene` calls `simulation.step(delta, elapsed)` then `graphRenderer.update(...)` every frame, mutating instance matrices and color buffers directly.
- **Do not lift per-frame simulation state into React state.** It would trigger re-renders at 60 Hz and defeat the entire architecture.

---

## 4. Data Flow

### 4.1 The Ask Path (User Asks a Question)

```
User types in AskPanel
        │
        ▼
POST /api/ask  (SSE stream)
        │
        ▼
┌───────────────────────────────────────────────────────────────────┐
│  reasoning/pipeline.ts  —  7 steps                                │
│                                                                   │
│  1. input         → normalize, tokenize                           │
│  2. memory        → embed + vector search + recency/importance    │
│  3. reasoning     → JSON plan from LLM                            │
│  4. project       → project-name rerank                           │
│  5. error         → contradictions / missing / confidence (JSON)  │
│  6. response      → streamed answer with [m:<id>] citations       │
│                     in three sections: Known / Inferred /         │
│                     Uncertain                                     │
│  7. learning      → persist Q+A as MemoryPoint, link citations    │
└───────────────────────────────────────────────────────────────────┘
        │  each step calls emitAll(event)
        │
        ├──► SSE stream back to the originating tab
        │
        └──► WS broadcast on /ws/brain
                  │
                  ▼
        Every open tab's brainBus receives the event
                  │
                  ▼
        BrainScene expands event.logicalRegions via
        LOGICAL_REGION_MAP → anatomical IDs
                  │
                  ▼
        SignalSimulation.flash(regionIds)
                  │
                  ▼
        Next frame: pulses spawn in those regions,
                    intensity buffer is bumped, renderer paints
```

### 4.2 The Scan Path (Indexing Files)

```
POST /api/scan/run
        │
        ▼
scanner/walker  → enumerate files under root (budget-capped)
        │
        ▼
scanner/chunker → split each file into text chunks
        │
        ▼
scanner/indexer → for each chunk:
                    embed via active connector
                    insert into memory_points
                    insert vector into memory_vec
        │
        ▼
broadcast({type: "scan", ...}) on /ws/brain
        │
        ▼
Frontend updates progress UI; file-memory region (temporal lobe)
flashes for each batch
```

### 4.3 The Locality Path (Discovering Local LLM Runtimes)

```
Server boot  +  every 60 s
        │
        ▼
connectors/discovery.ts → probe 7 runtimes in parallel
                          (Ollama 11434, LM Studio 1234, llama.cpp 8080,
                           Jan 1337, GPT4All 4891, vLLM 8000, TGI 3000)
                          200 ms timeout, content-checked
        │
        ▼
reconcileDiscovered() upserts as auto-<kind>
        │
        ▼
/api/health reports locality: "local" | "remote"
        │
        ▼
LocalityBadge: green ("Purely local") if all enabled connectors
               isLocal === true, otherwise amber
```

### 4.4 Event Stream Contract

The same `PipelineEvent` shape (from `shared/pipeline.ts`) flows over both:

- **SSE** on `POST /api/ask` — scoped to the originating request.
- **WebSocket** on `/ws/brain` — broadcast to every subscribed tab.

This is intentional: any open tab sees activity even if it did not initiate the request. The WS reconnection bus (`src/engine/brainBus.ts`) backs off from 1 s to 30 s, logs the first failure, throttles subsequent reminders to ~60 s, and resets backoff on a successful reconnect.

---

## 5. Memory Visualization

Memories are first-class visual citizens. They are not abstract rows in a database — they appear as light, motion, and structure in the 3D scene.

### 5.1 Visual Encoding

| Memory Property | Visual Channel |
|---|---|
| **Recency** | Pulse brightness in the hippocampus. Fresh memories spawn brighter, slower-decaying pulses. |
| **Importance** (from `memory/importanceScorer.ts`) | Neuron base color intensity in the memory-core region. Higher importance → warmer, more saturated nodes. |
| **Access frequency** (from `accessPatternTracker`) | Pathway thickness between hippocampus and the relevant cortex. Hot paths glow persistently. |
| **Retrieval event** (vector hit in step 2) | A pulse spawned at the hippocampus that traverses to the `reasoning-cortex`, then to `response-center`. |
| **Citation in answer** (`[m:<id>]` marker) | The cited memory's neuron emits a bright flash when its marker is streamed. |
| **Consolidation** (background tick from `consolidationEngine`) | Slow, rhythmic glow in the hippocampus + cortex pair being consolidated. |
| **Decay** (`memoryLifecycle`) | Gradual desaturation of the corresponding neuron over time. |
| **Novelty** (`noveltyDetector`) | A burst at the entorhinal cortex when a sufficiently-novel input arrives. |
| **Cluster membership** (`semanticCluster`) | Spatial proximity of neurons within the memory region — clustered memories sit near each other in the deterministic graph layout. |

### 5.2 Mechanics

- The renderer never instantiates one mesh per memory. All neurons are packed into a single `InstancedMesh`; per-memory state is written into instance matrices and a per-vertex color buffer.
- Hiding a region writes a zero-scale matrix for its neurons — it does **not** toggle `visible` on individual meshes.
- The `MAX_PULSES = 260` cap in `signalSimulation.ts` keeps the active pool bounded; new pulses recycle the oldest slot.
- Graph generation is seeded (`seed = round(density * 1000) + 19`) so the same density value always produces the same memory layout — replays are deterministic.

---

## 6. Performance Targets & Technical Constraints

### 6.1 Performance Targets

| Metric | Target | Mechanism |
|---|---|---|
| Render frame rate | **≥ 60 FPS** at highest density tier on integrated GPUs | Instanced rendering, `useAutoQuality` adaptive scaling, no per-frame React state |
| Pipeline step latency (steps 1, 4, 5, 7) | < 50 ms p95 | All local, no network |
| Memory retrieval (step 2) | < 150 ms p95 for ≤100k memories | `sqlite-vec` ANN + recency/importance boost |
| LLM step latency (steps 3, 6) | Bounded by local runtime; pipeline does not block on it | SSE streaming, partial events |
| Cold boot (server) | < 2 s on dev machine | Idempotent schema, lazy connector probes |
| WebSocket reconnect | 1 s → 30 s exponential backoff | `brainBus.ts` |
| Discovery probe per runtime | 200 ms hard timeout | `connectors/discovery.ts` |

### 6.2 Technical Constraints

- **TypeScript strict mode** in both `src/` and `server/`. Build fails on implicit `any` or unchecked nullables.
- **Server is ESM.** Relative imports inside `server/src/` must use `.js` extensions even when the source is `.ts`.
- **`shared/` has zero runtime dependencies.** Types and plain constants only.
- **Three.js pinned to `^0.171.0`.** Examples (`OrbitControls`, `EffectComposer`, etc.) sometimes break across minor releases — do not bump casually.
- **Dev server bound to `127.0.0.1:5173`.** The host binding is intentional (`scripts/verify-canvas.mjs` and `tauri.conf.json` both target that exact URL).
- **`sqlite-vec` is optional.** If the extension fails to load, the server keeps running, `vectorSearch` becomes a no-op, and `/api/health` reports `vector: "unavailable"`.
- **`LOCAL_ONLY=true` by default.** `POST /api/connectors` rejects any non-loopback / non-RFC1918 host. Override only by setting `LOCAL_ONLY=false` in `server/.env`.
- **Scan budget.** `MAX_FILES_PER_SCAN × MAX_FILE_BYTES` keeps an accidentally-pointed-at-`C:\` scan from spiralling.

### 6.3 Quality Gates

There is no traditional unit-test runner. The wired-up gates are:

| Command | What It Verifies |
|---|---|
| `npm run build` | Frontend: `tsc --noEmit` then `vite build`. |
| `npm run typecheck` (in `server/`) | Server type-check. |
| `npm run verify:canvas` | Headless smoke test: launches Chrome via CDP, samples a 96×60 region of the canvas, asserts ≥90 pixels have luma >24. Catches `Runtime.exceptionThrown`. |
| `npm run test:actions` | Per-action assertion suite. Clicks each of the 7 action buttons, asserts the active region matches `regionDefinitions.ts`, screenshots into `artifacts/actions/`. |
| `npm run test:all` | Boots Vite, runs both smoke checks, tears Vite down. |
| `npm run ranker:selfcheck` | Learned-ranker sanity. |
| `npm run agents:selfcheck` | TS agentic layer. |
| `npm run twin:selfcheck` | Digital-twin collectors/predictor. |

---

## 7. Phased Roadmap

### MVP — Phase 1 ✅ Shipped

**Goal:** A working 3D brain that lights up when a local LLM thinks.

- [x] 30-region anatomical brain rendered in Three.js
- [x] Deterministic neural graph generator with density tier
- [x] `SignalSimulation` with weighted pulse spawning per action
- [x] Action panel: 7 actions, each biased toward a region set
- [x] Express server with SQLite + `sqlite-vec`
- [x] 7-step reasoning pipeline (`input` → `learning`)
- [x] Ollama connector with embedding + streaming
- [x] SSE on `POST /api/ask`, WS broadcast on `/ws/brain`
- [x] AskPanel with three-section response rendering
- [x] File scanner (walker + chunker + indexer)
- [x] Headless smoke tests (`verify:canvas`, `test:actions`)

### v1.0 — Phase 2 🚧 In Progress

**Goal:** Memory becomes intelligent. The system maintains itself.

- [x] Memory ML layer (`importanceScorer`, `memoryStrength`, `memoryLifecycle`, `consolidationEngine`, `noveltyDetector`, `predictivePrefetch`, `semanticCluster`, `accessPatternTracker`, `thresholdController`)
- [x] Learned ranker for memory retrieval (`reasoning/ranker.ts` + `rankerModel.ts`)
- [x] TS agentic runtime (`observerAgent`, `summaryAgent`, `schedulerAgent`, `systemSensorAgent`, `brainCore`)
- [x] Digital twin (`twin/collectors`, `snapshotEngine`, `predictiveModel`, `anomalyDetector`, `simulationEngine`)
- [x] Brain OS layout modes (`CompactLayout`, `FocusMode`, `CommandPalette`)
- [x] Auto-quality (`useAutoQuality` + `adaptiveQuality`)
- [x] Phase 2 organism subsystems (`evolution`, `imagination`, `organism`, `swarm`) behind routers
- [x] Locality enforcement (`LOCAL_ONLY`, `isLocalUrl`, `LocalityBadge`)
- [x] Multi-runtime discovery (Ollama, LM Studio, llama.cpp, Jan, GPT4All, vLLM, TGI)
- [x] Unified OpenAI-compatible connector
- [x] Tauri desktop shell with strict CSP
- [x] Computer Brain workspace (separate Cargo workspace, 28 crates)
- [ ] Memory ML metrics surfaced in the UI
- [ ] Twin anomaly alerts wired into the visualizer
- [ ] Swarm / imagination panels move from experimental to documented

### Future — Phase 3

**Goal:** Cross the local-quality ceiling without leaving localhost.

- [ ] Python sidecar in `worker/` for sentence-transformers + cross-encoder reranking
- [ ] Replace Ollama embeddings with sidecar embeddings behind the existing `getEmbedder()` seam
- [ ] Conversational memory graph (relations between memories, not just vectors)
- [ ] Multi-agent debate visualized as inter-region negotiation
- [ ] Replay mode: scrub a saved pipeline run frame-by-frame
- [ ] Voice-driven Ask path end-to-end (already partially wired via `aiCompanion`)
- [ ] Tauri-side computer-use integration (read screen, control mouse) gated behind explicit user consent

---

## 8. File Structure

```
star/
├── src/                          # Vite + React + Three.js frontend
│   ├── App.tsx                   # Top-level state, layout mode selector
│   ├── components/
│   │   ├── BrainScene.tsx        # Single Three.js host
│   │   ├── NeuralGraph.tsx       # InstancedMesh renderer
│   │   ├── RegionControls.tsx
│   │   ├── InfoPanel.tsx
│   │   ├── AskPanel.tsx          # /api/ask SSE consumer
│   │   ├── PipelineOverlay.tsx
│   │   ├── LogicalRegionIndicator.tsx
│   │   ├── AiCompanion.tsx       # Direct-to-Ollama path
│   │   └── brain-os/             # Layout modes
│   │       ├── CompactLayout.tsx
│   │       ├── FocusMode.tsx
│   │       ├── CommandPalette.tsx
│   │       ├── DigitalTwinPanel.tsx
│   │       ├── SwarmPanel.tsx
│   │       ├── EvolutionPanel.tsx
│   │       ├── OrganismPanel.tsx
│   │       ├── ImaginationPanel.tsx
│   │       ├── Phase2CortexPanel.tsx
│   │       └── UnifiedPanel.tsx
│   ├── engine/
│   │   ├── types.ts              # BrainRegionId, BrainActionId
│   │   ├── brainRegions.ts       # Lookups + REGION_CONNECTIONS
│   │   ├── logicalRegions.ts     # LOGICAL_REGION_MAP
│   │   ├── neuralGraphGenerator.ts
│   │   ├── signalSimulation.ts   # MAX_PULSES = 260
│   │   ├── apiClient.ts          # /api wrapper + ask() generator
│   │   ├── brainBus.ts           # WS /ws/brain singleton
│   │   ├── useLayoutMode.ts
│   │   ├── useCommandPalette.ts
│   │   ├── useAutoQuality.ts
│   │   ├── adaptiveQuality.ts
│   │   ├── performancePresets.ts
│   │   ├── ollamaClient.ts
│   │   ├── aiCompanion.ts
│   │   ├── audioBus.ts
│   │   ├── speechInput.ts
│   │   └── speechOutput.ts
│   └── data/
│       └── regionDefinitions.ts  # ~30 anatomical regions
│
├── server/                       # Express + TypeScript backend
│   └── src/
│       ├── index.ts              # Boot, schema apply, router wiring, WS attach
│       ├── config.ts             # Env-driven config, localOnly flag
│       ├── db/
│       │   ├── sqlite.ts         # WAL mode, sqlite-vec load
│       │   ├── schema.sql        # Idempotent schema
│       │   └── repositories/
│       │       ├── memory.ts
│       │       ├── conversations.ts
│       │       ├── connectors.ts
│       │       ├── scan.ts
│       │       └── ranker.ts
│       ├── reasoning/
│       │   ├── pipeline.ts       # 7-step pipeline
│       │   ├── prompts.ts
│       │   ├── ranker.ts         # Learned re-ranker
│       │   └── rankerModel.ts
│       ├── memory/               # Memory ML layer
│       │   ├── importanceScorer.ts
│       │   ├── memoryStrength.ts
│       │   ├── memoryLifecycle.ts
│       │   ├── consolidationEngine.ts
│       │   ├── noveltyDetector.ts
│       │   ├── predictivePrefetch.ts
│       │   ├── semanticCluster.ts
│       │   ├── accessPatternTracker.ts
│       │   └── thresholdController.ts
│       ├── agents/               # TS agentic runtime
│       │   ├── Agent.ts
│       │   ├── runtime.ts
│       │   ├── brainCore.ts
│       │   ├── observerAgent.ts
│       │   ├── summaryAgent.ts
│       │   ├── schedulerAgent.ts
│       │   └── systemSensorAgent.ts
│       ├── twin/                 # Digital twin
│       │   ├── collectors/
│       │   ├── snapshotEngine.ts
│       │   ├── cpuMath.ts
│       │   ├── predictiveModel.ts
│       │   ├── anomalyDetector.ts
│       │   ├── simulationEngine.ts
│       │   └── repository.ts
│       ├── core/                 # Phase 2 subsystems
│       │   ├── eventBus.ts
│       │   ├── evolution/
│       │   ├── imagination/
│       │   ├── organism/
│       │   ├── swarm/
│       │   └── safety/
│       ├── connectors/
│       │   ├── Connector.ts      # Interface
│       │   ├── OllamaConnector.ts
│       │   ├── OpenAIConnector.ts
│       │   ├── OpenAICompatibleConnector.ts
│       │   ├── registry.ts
│       │   └── discovery.ts      # 7-runtime probe
│       ├── scanner/
│       │   ├── walker.ts
│       │   ├── chunker.ts
│       │   └── indexer.ts
│       ├── routes/
│       │   ├── health.ts
│       │   ├── memory.ts
│       │   ├── scan.ts
│       │   ├── connectors.ts
│       │   ├── ask.ts            # SSE
│       │   └── conversations.ts
│       ├── ws/
│       │   └── brainBus.ts       # /ws/brain hub
│       └── util/
│           └── network.ts        # isLocalUrl()
│
├── shared/                       # Zero-runtime-deps type contracts
│   ├── pipeline.ts               # LogicalRegionId, PipelineEvent
│   ├── memory.ts                 # MemoryPoint, MemoryRelation
│   ├── connector.ts
│   ├── twin.ts
│   ├── swarm.ts
│   ├── evolution.ts
│   ├── imagination.ts
│   ├── organism.ts
│   └── phase2.ts
│
├── src-tauri/                    # Tauri 2 desktop shell (Rust)
│   ├── tauri.conf.json           # Strict CSP, devUrl: 127.0.0.1:5173
│   ├── Cargo.toml                # Consumes crates/ as path deps
│   └── src/
│       ├── lib.rs
│       ├── commands.rs
│       ├── database.rs           # Separate from server's SQLite!
│       ├── llm_probe.rs          # Mirrors server discovery table
│       └── phase2.rs             # Tauri-managed Phase2System
│
├── crates/                       # Phase 2 Rust crates (no root Cargo.toml)
│   ├── brain-autonomous-runtime/
│   ├── brain-context-engine/
│   ├── brain-knowledge-graph/
│   ├── brain-personality-engine/
│   ├── brain-semantic-memory/
│   ├── brain-temporal-engine/
│   └── brain-workflow-engine/
│
├── computer-brain/               # SEPARATE Cargo workspace (28 crates)
│   ├── Cargo.toml
│   ├── crates/                   # Architectural cousin, not shared
│   ├── apps/desktop-pet/
│   │   ├── src-tauri/            # Its own Tauri app
│   │   └── package.json
│   └── docs/
│       ├── ARCHITECTURE.md
│       └── BUILD.md
│
├── worker/                       # Phase 3 Python sidecar PLACEHOLDER
│   └── README.md
│
├── scripts/
│   ├── verify-canvas.mjs         # CDP smoke test
│   ├── smoke-actions.mjs         # Per-action assertions
│   ├── test-all.mjs              # Orchestrator
│   ├── ranker-selfcheck.ts
│   └── scan.mjs                  # WS-streamed scan trigger
│
├── data/                         # Gitignored: brain.sqlite lives here
├── artifacts/                    # Gitignored: screenshots
├── docs/
│   └── PHASE2_ARCHITECTURE.md
├── CLAUDE.md                     # Project instructions for Claude Code
├── PERSONAL_MEMORY_BRAIN_SPEC.md # Forward-looking design
├── DIGITAL_TWIN_SPEC.md          # Forward-looking design
└── SPEC.md                       # This file
```

---

## 9. Conventions

- **TypeScript strict mode** in both `src/` and `server/`.
- **React 18** with the automatic JSX runtime (`jsx: "react-jsx"`). No `import React` needed.
- **Three.js** as `import * as THREE from "three"`. Examples come from `three/examples/jsm/...`.
- **Server is ESM.** Relative imports inside `server/src/` use `.js` extensions even for `.ts` sources. Imports of `shared/` use `.js` too, e.g. `from "../../../shared/pipeline.js"`.
- **`shared/` has zero runtime dependencies.** Types and plain constants only.
- **`data/`, `artifacts/`, `dist/`, `worker/.venv/`, `server/dist/`** are gitignored. Assume they may not exist on a fresh checkout.
- **Two Rust workspaces.** `crates/` serves the root Tauri shell. `computer-brain/crates/` serves the inner desktop-pet app. They are not the same code.
- **Locality.** `isLocalUrl()` in `server/src/util/network.ts` is the only allowed gate for connector URLs. Both inputs and outputs go through that helper.

---

## 10. Out of Scope (Explicitly)

To keep the spec honest, here is what this project is **not** doing:

- **No cloud deployment surface.** No Docker production targets, no Kubernetes manifests, no managed-service integrations beyond optionally-configured remote LLM endpoints.
- **No authentication or multi-tenancy.** Single-user, single-machine.
- **No biological-accuracy claim.** Region-to-function mappings are inspired, not validated.
- **No browser-side LLM inference.** The browser talks to a local runtime via the server (or directly to Ollama via `aiCompanion` for the companion feature). It does not run weights itself.
- **No telemetry.** No analytics, no error reporting to external services. Logs stay on disk.

---

## Appendix A — Key Files to Read First

If you are new to the codebase, read in this order:

1. `CLAUDE.md` — project conventions and the why-behind-the-architecture.
2. `shared/pipeline.ts` — the event contract every other piece speaks.
3. `src/engine/logicalRegions.ts` — the mapping between logical and anatomical regions.
4. `server/src/reasoning/pipeline.ts` — the 7-step pipeline.
5. `src/components/BrainScene.tsx` — the Three.js host and the WS subscription.
6. `src/engine/signalSimulation.ts` — how thoughts become light.

## Appendix B — Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Server listen port |
| `HOST` | `127.0.0.1` | Server bind address |
| `LOCAL_ONLY` | `true` | Enforce loopback/RFC1918 connector URLs |
| `DEFAULT_SCAN_ROOT` | (none) | Default root for `/api/scan/run` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_CHAT_MODEL` | (model-dependent) | Default chat model |
| `OLLAMA_EMBED_MODEL` | (model-dependent) | Default embedding model |
| `EMBEDDING_DIM` | (model-dependent) | Vector dimension for `memory_vec` |
| `MAX_FILES_PER_SCAN` | (capped) | Scan budget |
| `MAX_FILE_BYTES` | (capped) | Per-file scan budget |
| `ALLOWED_ORIGIN` | `http://127.0.0.1:5173` | CORS origin |
| `VITE_BRAIN_API_URL` | `http://127.0.0.1:8787` | Frontend override for server URL |
| `VERIFY_URL` | `http://127.0.0.1:5173/` | Target for `verify:canvas` |
