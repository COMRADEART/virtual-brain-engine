# Virtual Brain Engine — Unified Architecture Blueprint

> **What this is.** A single, grounded design document for the "Virtual Brain
> Engine" vision — a persistent, continuously-evolving cognitive operating
> system rather than a request→LLM→response chatbot. It delivers all 16 of the
> design deliverables (architecture, folder structure, module breakdown,
> data-flow, neural-memory architecture, event system, DB schema, agent
> orchestration, visualization, cognition loop, deployment, API, local-first
> model, autonomous algorithms, real-time pipeline) **by mapping the vision onto
> the code that already exists in this repo** and naming the genuine gaps. §18
> extends this to the larger framing (22 modules / 20 deliverables) — cognitive
> energy, competing thought streams, curiosity, meta-cognition, temporal
> cognition, self-preservation, hybrid reasoning, and the "cognitive ecology" of
> faculty agents — against the same code.
>
> **Prime directive.** This is *not* a from-scratch build. ~70% of the vision is
> already implemented here in a **local-first TypeScript/React/Three.js + Rust**
> stack. The prompt's suggested stack (Python / Neo4j / Qdrant / Kafka / Unreal
> Engine 5) is **deliberately not adopted** — it would duplicate working
> subsystems and break the project's enforced `LOCAL_ONLY=true` guarantee
> (`server/src/config.ts`). Appendix A maps each suggested technology to its
> already-present local equivalent.
>
> **Read order.** Read the code for *what is*, the `*_SPEC.md` files for *why*,
> and this doc for *how it all fits and what remains*. It supersedes the spiking
> sections of `docs/plans/2026-05-22-personal-brain-os-roadmap.md`, which predate
> the `AdvancedBrainCore` (117c2fb) and `HybridCognitiveCore` (89a9102) commits.

**Status legend used throughout:**

| Marker | Meaning |
|--------|---------|
| ✅ **Built** | Implemented, compiles, exercised at runtime. |
| 🟡 **Partial** | Real implementation exists but a named capability is missing or simplified. |
| 🔴 **Missing** | Spec'd here / in a SPEC file, no implementation yet. |
| 🧪 **Unverified** | Code exists and compiles but has not been validated at runtime (e.g. blocked by a broken gate). |

---

## §1 — Complete System Architecture

The system is a **layered cognitive OS** running across cooperating processes,
not a single service. The biological cognition cycle the prompt asks for —

```
Perception → Attention → Interpretation → Emotion → Memory Association →
Prediction → Goal Evaluation → Recursive Thought → Action → Reflection → Consolidation
```

— is realized as a **continuously-ticking set of loops at three timescales**,
each already present in the codebase:

```
                          ┌──────────────────────────────────────────────────────────┐
                          │                    PRESENTATION TIER                        │
                          │   Vite + React + Three.js  (src/)  — 127.0.0.1:5173        │
                          │   • Neural visualizer (BrainScene/NeuralGraph)             │
                          │   • Brain OS shells (compact / focus / command palette)    │
                          │   • Phase-2 panels (twin/swarm/evolution/organism/imag.)   │
                          │   • AI Companion (browser→Ollama, lazy)                     │
                          └───────────────▲───────────────────────▲──────────────────┘
                  HTTP /api │   SSE POST /api/ask │      WS /ws/brain │ (BrainBusMessage)
                          ┌───────────────┴───────────────────────┴──────────────────┐
                          │                    COGNITION TIER                          │
                          │   Express + TypeScript (server/)  — 127.0.0.1:8787         │
                          │                                                            │
                          │   ┌── 7-step reasoning pipeline (reasoning/pipeline.ts) ─┐ │
                          │   │ input→memory→reasoning→project→error→response→learn  │ │
                          │   └──────────────────────────────────────────────────────┘ │
                          │   Memory ML (memory/)   Learned ranker (reasoning/ranker)  │
                          │   Agents (agents/)      Digital twin (twin/)               │
                          │   Organism · Swarm · Evolution · Imagination (core/)       │
                          │   Vision/perception (vision/)   Civilization (civilization/)│
                          │   Event bus (core/eventBus) + WS hub (ws/brainBus)         │
                          └───────────────▲───────────────────────▲──────────────────┘
                       better-sqlite3     │      sqlite-vec        │  connectors (HTTP)
                          ┌───────────────┴───────────┐  ┌────────┴─────────────────┐
                          │   STORAGE  data/brain.sqlite│  │  LOCAL MODEL RUNTIMES    │
                          │   40+ tables + memory_vec   │  │  Ollama / LM Studio /    │
                          │   (schema.sql, idempotent)  │  │  llama.cpp / Jan / vLLM …│
                          └─────────────────────────────┘  └──────────────────────────┘

   ┌─────────────────────────────────────────────────────────────────────────────────┐
   │  IN-BROWSER COGNITION ENGINE (src/engine/) — runs every animation frame           │
   │  SignalSimulation (default)  →  AdvancedBrainCore (?useSpiking)  →                 │
   │  HybridCognitiveCore (?useHybrid: System 1/2 + RL + meta-learning + IQ growth)     │
   └─────────────────────────────────────────────────────────────────────────────────┘

   ┌─────────────────────────────────────────────────────────────────────────────────┐
   │  OPTIONAL SHELLS / WORKSPACES                                                      │
   │  • src-tauri/ (Tauri 2 desktop) + crates/ (7 Phase-2 Rust engines)               │
   │  • computer-brain/ (separate 30-crate Rust cognitive nervous system)             │
   │  • worker/ (Python sidecar placeholder — Phase 3, not wired)                       │
   └─────────────────────────────────────────────────────────────────────────────────┘
```

### The 12 required modules → where they live (the master map)

| # | Required module | Status | Primary implementation |
|---|-----------------|--------|------------------------|
| 1 | **Perception Layer** (multimodal, screen, OCR, files) | 🟡 Partial | `server/src/vision/{capture,uiDetector,visualMemory,visualKnowledgeGraph}.ts`, `scanner/` (files), `src/engine/speechInput.ts` (voice). Spec: `docs/MULTIMODAL_SENSORY_CORTEX_SPEC.md`. **Gap:** no live video/Whisper pipeline wired server-side. |
| 2 | **Attention Engine** (saliency, novelty, focus) | 🟡 Partial | `memory/noveltyDetector.ts`, neuromod-gated drive + `setExpectation`/`flashRegions` in `AdvancedBrainCore`, `FOCUS_STATE` in `cognitiveStates.ts`, reasoning bias in `HybridCognitiveCore`. **Gap:** no single saliency scorer combining the four prompt terms (see §15). |
| 3 | **Associative Neural Memory** (graph, decay, emotional tags) | ✅ Built | `server/src/memory/*` + `db/repositories/memory.ts` + `memory_relations`/`memory_access_patterns`/`memory_clusters`. In-engine: `src/engine/MemorySystem.ts`. |
| 4 | **Continuous Thought Loop** (idle cognition) | 🟡 Partial | `HybridCognitiveCore.step()` (per-frame), `agents/brainCore.ts`, `core/organism.ts` lifecycle, `consolidationEngine` decay ticks. **Gap:** no server-side autonomous "internal monologue" generator. |
| 5 | **Emotional Computation** (weighting, not dialogue) | ✅ Built | `NeuromodulationSystem.ts` (DA/ACh/5-HT/NE), `ReinforcementSystem` affect (valence/arousal), `cognitiveStates.ts`. |
| 6 | **Predictive Cognition** (prediction error minimization) | ✅ Built | `PredictiveCodingEngine.ts` (free energy), `twin/predictiveModel.ts`, `memory/predictivePrefetch.ts`, `core/imagination.ts` (simulation trees). |
| 7 | **World Model** (self/user/environment, causal) | 🟡 Partial | `twin/` (environment+self), `organism_world_model` table, `personality-engine` crate. **Gap:** explicit causal-map structure is implicit, not first-class. |
| 8 | **Self-Model / Identity Core** | ✅ Built | `identity_profiles`/`evolution_identity_traits` tables, `cognition/persistence.ts` (cross-session brain snapshot), `crates/brain-personality-engine`. |
| 9 | **Neural Activity Visualization** | ✅ Built | The entire `src/components/` Three.js layer — `NeuralGraph.tsx`, `BrainScene.tsx`, `BrainVisualEffects.ts`. |
| 10 | **Memory Consolidation / Sleep** | ✅ Built | `memory/consolidationEngine.ts`, `replayService.ts` (hippocampal replay), `dream_cycles` table, `imagination` dream abstractions. |
| 11 | **Hierarchical Cognition** (abstraction levels) | 🟡 Partial | `memory/semanticCluster.ts`, `cognitive_abstractions` table, `ReasoningEngine` operators (analogy/counterfactual/ToM). **Gap:** no explicit 6-level sensory→philosophical ladder. |
| 12 | **Autonomous Goal System** | ✅ Built | `core/organism.ts` (goals/lifecycle/energy/health), `goal_history` table, `core/evolution.ts`, `agents/schedulerAgent.ts`. |

**Takeaway:** 7 of 12 modules are fully built, 5 are partial, **0 are missing**.
The work is *filling named gaps and verifying*, not greenfield construction.

---

## §2 — Folder Structure (annotated, cognitive view)

```
star/
├── src/                          # PRESENTATION + IN-BROWSER COGNITION
│   ├── components/
│   │   ├── BrainScene.tsx         # single Three.js host; selects the engine
│   │   ├── NeuralGraph.tsx        # InstancedMesh renderer (neurons/pathways/pulses)
│   │   ├── brain-os/              # CompactLayout, FocusMode, CommandPalette
│   │   └── …Panels                # DigitalTwin/Swarm/Evolution/Organism/Imagination
│   ├── engine/                   # ── THE COGNITION ENGINE (runs at 60 Hz) ──
│   │   ├── signalSimulation.ts    # default scripted engine (lightweight)
│   │   ├── AdvancedBrainCore.ts    # Izhikevich + CSR connectome + predictive coding
│   │   ├── IzhikevichNeuron.ts     # neuron population integrator
│   │   ├── RealisticConnectome.ts  # CSR sparse synapse graph
│   │   ├── BrainOscillations.ts    # theta/alpha/beta/gamma + cross-freq coupling
│   │   ├── NeuromodulationSystem.ts# DA/ACh/5-HT/NE → excitability + plasticity
│   │   ├── PredictiveCodingEngine.ts# free-energy / prediction error
│   │   ├── MemorySystem.ts         # working/episodic/semantic/procedural (in-engine)
│   │   ├── BrainDynamics.ts        # homeostasis + criticality (σ≈1)
│   │   ├── cognition/              # ── HIGHER COGNITION (System 2) ──
│   │   │   ├── HybridCognitiveCore.ts  # dual-process orchestrator (top of stack)
│   │   │   ├── ReasoningEngine.ts       # analogy / counterfactual / theory-of-mind
│   │   │   ├── ReinforcementSystem.ts   # RPE → dopamine → 3-factor plasticity → affect
│   │   │   ├── MetaLearningSystem.ts    # genome evolution + EWC + IQ growth
│   │   │   ├── persistence.ts           # cross-session snapshot (IndexedDB)
│   │   │   └── cognitionTypes.ts        # System1/2, Affect, Genome, IQReport
│   │   ├── brainBus.ts            # WS singleton client (/ws/brain)
│   │   ├── BrainEventBus.ts       # in-engine pub/sub (cognition events)
│   │   ├── apiClient.ts           # typed /api wrapper; ask() SSE generator
│   │   └── logicalRegions.ts      # 8 logical cortices → ~30 anatomical IDs
│   └── data/regionDefinitions.ts # anatomical region taxonomy
│
├── server/src/                   # COGNITION TIER (Express, 127.0.0.1:8787)
│   ├── index.ts                   # bootstrap: DB, connectors, ticks, routers, WS
│   ├── config.ts                  # LOCAL_ONLY, embeddingDim, civilizationEnabled…
│   ├── reasoning/
│   │   ├── pipeline.ts            # the 7-step cognitive pipeline
│   │   ├── prompts.ts             # per-step system prompts
│   │   ├── ranker.ts/rankerModel.ts # learned memory re-ranker (online LTR)
│   ├── memory/                    # MEMORY ML LAYER (see §6)
│   │   ├── consolidationEngine.ts # promote/consolidate/archive/decay (boot tick)
│   │   ├── replayService.ts       # hippocampal→neocortical replay (sleep)
│   │   ├── importanceScorer.ts / memoryStrength.ts  # Ebbinghaus decay + reinforce
│   │   ├── noveltyDetector.ts / semanticCluster.ts / predictivePrefetch.ts
│   │   ├── accessPatternTracker.ts / thresholdController.ts / memoryLifecycle.ts
│   ├── agents/                    # TS AGENTIC LAYER (observer/summary/scheduler/sensor)
│   │   ├── Agent.ts / runtime.ts / brainCore.ts
│   ├── twin/                      # DIGITAL TWIN (collectors→snapshot→predict→anomaly)
│   ├── core/                      # PHASE-2 ORGANISM SUBSYSTEMS + safety gate
│   │   ├── organism.ts / swarm.ts / evolution.ts / imagination.ts / eventBus.ts / safety.ts
│   ├── vision/                    # PERCEPTION (capture/uiDetector/visualMemory/KG)
│   ├── civilization/             # MULTI-BRAIN distributed cognition (opt-in)
│   ├── connectors/               # pluggable local LLM runtimes + discovery
│   ├── scanner/                  # files → chunks → MemoryPoint + embeddings
│   ├── db/{sqlite.ts,schema.sql,repositories/}
│   ├── routes/                   # /api/* routers (health/memory/scan/ask/…)
│   └── ws/brainBus.ts            # WS hub (broadcast BrainBusMessage)
│
├── shared/                       # PURE TYPES (zero runtime deps; both tiers import)
│   ├── pipeline.ts               # PipelineEvent, LogicalRegionId, BrainBusMessage union
│   ├── memory.ts / connector.ts / brainSnapshot.ts (CognitiveGenome)
│   └── twin/swarm/evolution/imagination/organism/vision/civilization.ts
│
├── crates/                       # 7 Phase-2 Rust engines (built only via src-tauri)
├── computer-brain/               # SEPARATE 30-crate Rust cognitive nervous system (CLAUDE.md says 28 — stale)
├── src-tauri/                    # Tauri 2 desktop shell (Rust) + own SQLite
├── worker/                       # Python sidecar placeholder (Phase 3, unwired)
└── docs/                         # this blueprint + SPECs + roadmap + neuroscience
```

---

## §3 — Module Breakdown (the 12, with gaps named)

For each: **intent → where → status → the one gap that matters.**

1. **Perception Layer** — 🟡 Built for screen + files; voice partial; video/Whisper missing.
   `vision/capture.ts` (screen), `vision/uiDetector.ts` (UI region detection),
   `vision/visualMemory.ts` + `visual_memory`/`visual_regions` tables, `scanner/`
   (document ingestion). **Gap:** `worker/` Whisper/vision sidecar is a placeholder;
   wire `src/engine/speechInput.ts` → a server `/api/perceive` endpoint for true
   multimodal fusion.

2. **Attention Engine** — 🟡 The mechanisms exist; the unified scorer doesn't.
   Novelty: `memory/noveltyDetector.ts`. Goal-relevance + emotional weight:
   neuromod-gated drive in `AdvancedBrainCore` step §2 ("drive = tonic + action +
   oscillation + cognitive-state + prediction-error … × neuromodulatory
   excitability"). Focus: `FOCUS_STATE` + System-2 `setExpectation`. **Gap:** the
   prompt's `attention = novelty + goal_relevance + emotional_weight +
   survival_importance` is spread across modules — fold into one
   `attention/saliency.ts` (see §15, §17 roadmap).

3. **Associative Neural Memory** — ✅ The strongest pillar. Graph = `memory_relations`
   (weighted, typed edges) + `memory_access_patterns` (co-access/spreading
   activation) + `memory_clusters` (semantic). Decay/reinforcement =
   `importanceScorer` + `memoryStrength` (Ebbinghaus). Emotional tag = `importance`
   + metadata. In-engine analogue: `MemorySystem.ts` (working/episodic/semantic/
   procedural with STDP + systems consolidation). See §6.

4. **Continuous Thought Loop** — 🟡 Per-frame loop is real (`HybridCognitiveCore.step`);
   background server cognition runs on timers (`scheduleDecayTick`,
   `civilization`, `organism` lifecycle). **Gap:** no autonomous internal-monologue
   generator that runs an idle reasoning pass without a user prompt — the seam is
   `agents/brainCore.ts` + a new idle-tick agent. See §11.

5. **Emotional Computation** — ✅ Genuine emotion-as-weighting. Four neuromodulators
   (`NeuromodulationSystem.ts`) modulate excitability + 3-factor plasticity.
   `ReinforcementSystem` derives a 2-D **valence/arousal** affect (`Affect` in
   `cognitionTypes.ts`) from reward-prediction error; arousal feeds the System-2
   arbitration uncertainty (`HybridCognitiveCore.computeUncertainty`). No fake
   "I feel happy" dialogue — it's cognition weighting.

6. **Predictive Cognition** — ✅ `PredictiveCodingEngine.ts` computes free energy /
   prediction error fed back as bottom-up drive (`PE_SCALE` in `AdvancedBrainCore`).
   `core/imagination.ts` builds **simulation trees** of candidate futures with
   risk/confidence, then `imagination_reflections` compares prediction to reality
   (the spec's `Prediction Error = Reality − Expected`). `twin/predictiveModel.ts`
   forecasts system metrics. **Gap (minor):** twin forecaster is statistical, not a
   recurrent/transformer sequence model.

7. **World Model** — 🟡 `twin/` is the environment+self model; `organism_world_model`
   table holds user habits / project evolution / installed tools / trends;
   `personality-engine` crate models the user. **Gap:** causal maps are implicit
   (imagination's transition model) rather than a queryable causal graph.

8. **Self-Model / Identity Core** — ✅ Persistent across sessions. In-engine learned
   state (connectome weights, neuromod tone, value function, genome, IQ history,
   EWC importance) serializes via `cognition/persistence.ts` (IndexedDB, gated on
   exact graph topology). Server-side: `identity_profiles`,
   `evolution_identity_traits`, `continuity_snapshots`. Reflection: `ReasoningEngine`
   + `reflection-engine` crate.

9. **Neural Activity Visualization** — ✅ Real-time, GPU-instanced (see §10).
   Visualizes region intensity, membrane potential heatmap, travelling pulses,
   neuromodulator levels, oscillation phase, burst/memory traces, and pipeline
   "routing" flashes.

10. **Memory Consolidation / Sleep** — ✅ `consolidationEngine.ts` runs decay +
    promote/archive on a boot-scheduled tick; `replayService.ts` emits hippocampal→
    neocortical `replay` events over the bus that the engine reactivates
    (`handleReplayEvent`); `dream_cycles` + `imagination-dream` abstractions form
    concepts offline (`cognitive_abstractions` table).

11. **Hierarchical Cognition** — 🟡 `semanticCluster.ts` + `cognitive_abstractions`
    form concepts from instances; `ReasoningEngine` operates above raw activation.
    **Gap:** the explicit 6-level ladder (sensory→object→semantic→conceptual→
    strategic→philosophical) isn't a typed structure — clusters are flat.

12. **Autonomous Goal System** — ✅ `core/organism.ts` generates/prioritizes/tracks
    goals with energy + health budgets (`goal_history`, `energy_usage`,
    `cognitive_health` tables); `core/evolution.ts` mutates cognitive components
    under benchmark gates; `schedulerAgent` paces work.

---

## §4 — Data-Flow Diagrams

**(a) The cognitive cycle (per-frame, in-browser engine).** This is the literal
`while alive:` loop, realized in `AdvancedBrainCore.step()` wrapped by
`HybridCognitiveCore.step()`:

```
 perceive            interpret/associate         predict            reflect/act
 ┌────────┐  drive   ┌──────────────┐  spikes   ┌──────────┐  PE   ┌───────────┐
 │ action │─────────▶│ oscillations │──────────▶│ Izhikevich│──────▶│ predictive│
 │ sensory│  +tonic  │ neuromod     │  CSR prop │ integrate │ spikes│ coding    │
 │ text   │  +osc    │ (DA/ACh/5HT) │◀──────────│ + STDP    │       │ free-E    │
 └────────┘  +cogst  └──────────────┘  plastic. └──────────┘       └─────┬─────┘
      ▲          ×excitability ×homeostasis            │                  │ uncertainty
      │                                                ▼                  ▼
      │   ┌────────────────────────────────────────────────────┐  ┌────────────┐
      └───┤ ARBITRATION: surprise+RPE-vol+crit-drift+arousal    │◀─┤ System 2:  │
   bias   │  ≥ threshold? → engage System 2 (≤10 Hz, budgeted)  │  │ analogy/   │
   regions│  RPE → dopamine → 3-factor plasticity → affect      │  │ counterfac/│
          └────────────────────────────────────────────────────┘  │ ToM        │
                          │ meta-learning (genome/EWC/IQ)          └────────────┘
                          ▼
                  visual buffers → NeuralGraphRenderer (60 Hz)
```

**(b) The ask pipeline (server) + dual fan-out.** Every step calls `emitAll(...)`
which writes the SAME `PipelineEvent` to **both** the SSE response (initiator) and
the WS hub (every open tab):

```
 POST /api/ask ──▶ pipeline.ts
   input ─▶ memory ─▶ reasoning ─▶ project ─▶ error ─▶ response ─▶ learning
     │        │ embed+vector       │JSON plan          │stream      │persist Q+A
     │        │+recency/import     │                   │3 sections  │+link cites
     │        │+learned ranker     │                   │[m:<id>]    │
     ▼        ▼                    ▼                   ▼            ▼
   ┌─────────────────────── emitAll(PipelineEvent) ───────────────────────┐
   │  SSE stream  ──▶ initiating browser (AskPanel)                        │
   │  WS broadcast ──▶ ALL tabs ──▶ BrainScene flashes logicalRegions      │
   └──────────────────────────────────────────────────────────────────────┘
```

**(c) Memory read / write / consolidate (associative store).**

```
 WRITE: file/conversation ─▶ scanner/indexer or learning step
        ─▶ embed ─▶ memory_points (+ memory_vec) ─▶ memory_relations (links)
        ─▶ importanceScorer (initial salience)

 READ:  query ─▶ embed ─▶ sqlite-vec ANN ─▶ recency/importance boost
        ─▶ learned ranker re-score ─▶ accessPatternTracker (spreading activation)
        ─▶ cite [m:<id>] (validated against retrieved set)

 CONSOLIDATE (background tick + sleep):
        decay (Ebbinghaus) ─▶ promote/archive (thresholdController)
        ─▶ semanticCluster (concept formation) ─▶ replayService (theta-paced)
        ─▶ WS 'replay' / 'consolidation' events ─▶ engine reactivation + viz
```

**(d) Render vs React boundary (the core perf invariant).** Simulation state
(`regionIntensity`, `pathwayIntensity`, `pulses`) lives in mutable Float32Arrays
**outside React**. React owns *config only*; per-frame state never triggers
re-renders. (See §10.)

---

## §5 — Cognitive Pipeline Design

Two pipelines coexist; do not conflate them.

**(i) The reactive 7-step server pipeline** (`reasoning/pipeline.ts`) — runs when a
user asks. Steps and their logical-cortex routing (`LogicalRegionId`):

| Step | Cortex | What happens |
|------|--------|--------------|
| `input` | — | normalize prompt, open `pipeline_run` |
| `memory` | `memory-core`, `file-memory` | embed → `sqlite-vec` ANN → recency/importance boost → learned ranker |
| `reasoning` | `reasoning-cortex` | LLM emits a JSON plan |
| `project` | `project-cortex` | project-name rerank of retrieved memory |
| `error` | `error-detection-center` | contradictions / missing-info / confidence (JSON) |
| `response` | `response-center`, `model-hub` | streamed answer in `Known memory:` / `Inferred reasoning:` / `Uncertain:` with validated `[m:<id>]` citations |
| `learning` | `learning-feedback-center` | persist Q+A as a `MemoryPoint`, link to cited memories |

**(ii) The continuous dual-process cognition loop** (`HybridCognitiveCore.step`) —
runs every frame, prompt or no prompt. System 1 (the spiking
`AdvancedBrainCore`) is mandatory each frame; **arbitration** computes a scalar
uncertainty and, above a meta-learned threshold, engages **System 2** (bounded,
≤10 Hz, hard ≤2.5 ms/frame budget) whose conclusion biases System 1 through
existing seams (`setExpectation` / `FOCUS_STATE` / `flashRegions`). Reinforcement
updates every frame; meta-learning ticks only in leftover budget.

The bridge between them: a completed `response` step emits a small extrinsic
reward (+0.8); a surfaced `error` step a penalty (−0.4) — so the reactive
pipeline *trains* the continuous engine (`HybridCognitiveCore` constructor,
`subscribeBrainBus`).

---

## §6 — Neural Memory Architecture

The prompt's seven memory types map onto a **two-substrate** design: a fast
in-engine store (volatile, for the live simulation) and a durable server store
(the persistent associative graph).

| Memory type | In-engine (`MemorySystem.ts`) | Durable (SQLite) |
|-------------|-------------------------------|------------------|
| Sensory | transient drive injection (`injectSensoryText`) | — (ephemeral by design) |
| Working | PFC sustained drive (`WM_SCALE`), 4±1 capacity | — |
| Episodic | hippocampal trace + replay | `memory_points(source_type='conversation')` + `messages` |
| Semantic | temporal-cortex weights | `memory_points(source_type='chunk')` + `memory_clusters` |
| Procedural | STDP-shaped pathways | `evolution_components(kind='workflow'|'skill')` |
| Emotional | neuromod tagging of encoding | `importance` + metadata on `memory_points` |
| Identity | persisted connectome + genome | `identity_profiles`, `continuity_snapshots` |

**The associative graph** (the prompt's "Neo4j" — done in SQLite):

```
 memory_points ──(memory_relations: weighted, typed kind)──▶ memory_points
       │                                                          ▲
       │  memory_access_patterns(coaccess_count, total_activation) │ spreading
       │  ──────────────── activation propagation ────────────────┘
       │
       └─ memory_clusters(topic, memory_ids, coherence)  ← semantic grouping
          memory_sequence_patterns / memory_temporal_patterns ← predictive prefetch
          memory_vec (sqlite-vec virtual table)  ← ANN similarity
```

Node contents (the prompt's required fields) are realized as: semantic meaning
(`content` + `embedding`), emotional weight (`importance`), temporal context
(`created_at`/`updated_at` + temporal patterns), relationship strength
(`memory_relations.weight`), activation frequency (`memory_access_log` +
`coaccess_count`). Decay = Ebbinghaus in `memoryStrength.ts`; reinforcement on
access; forgetting via `thresholdController` archival.

**Retrieval fusion** today: vector ANN → recency/importance boost → learned
ranker. **Gap (🟡):** graph-traversal retrieval (Personalized PageRank / weighted
shortest-path over `memory_relations`) is not yet fused into the ranker (§17).

---

## §7 — Event System Design

Three buses at three scopes — all carrying typed messages, none requiring Kafka:

| Bus | Scope | File | Contract |
|-----|-------|------|----------|
| `BrainEventBus` | in-engine (browser) | `src/engine/BrainEventBus.ts` | cognition events (`meta:iq`, `cognition:mode`, replay…) |
| `brainBus` (WS) | server ⇄ all tabs | `src/engine/brainBus.ts` (client) + `server/src/ws/brainBus.ts` (hub) | **`BrainBusMessage`** union (`shared/pipeline.ts`) |
| `eventBus` | server-internal | `server/src/core/eventBus.ts` | organism/swarm/evolution/imagination fan-out |

The **wire contract** is the discriminated union `BrainBusMessage` in
`shared/pipeline.ts` — 30+ variants spanning `pipeline`, `scan`, `connector`,
`memory-count`, `consolidation`, `replay`, agent status, twin, swarm, evolution,
imagination, organism, and vision messages. Adding a subsystem event = add a
variant there (single source of truth for both tiers). SSE (`POST /api/ask`) and
WS carry the same `PipelineEvent` shape so any tab sees activity it didn't
initiate. Reconnect backoff: 1 s → 30 s, quiet logging, resets on success.

---

## §8 — Database Schema

One durable SQLite DB (`data/brain.sqlite`, WAL, FKs on), schema applied
idempotently every boot (`db/schema.sql` + a `schema_migrations`-tracked
migration runner). The `memory_vec` virtual table is created at load time only if
`sqlite-vec` loads (graceful degradation otherwise). **40+ tables, grouped by
cognitive domain:**

- **Core memory & dialogue:** `memory_points`, `memory_relations`, `conversations`,
  `messages`, `pipeline_runs`, `files`, `scan_roots`, `connectors`.
- **Memory ML:** `ranker_state`, `memory_access_patterns`, `memory_access_log`,
  `memory_clusters`, `memory_sequence_patterns`, `memory_temporal_patterns`,
  `brain_metadata`.
- **Digital twin:** `system_snapshots` (5 state layers in one `layers_json`),
  `anomaly_logs`, `twin_predictions` (logged prediction + later actual),
  `simulation_results`.
- **Imagination:** `imagination_sessions`, `imagination_timeline`,
  `imagination_reflections`, `cognitive_abstractions`.
- **Evolution:** `evolution_components` (versioned genomes), `evolution_mutations`
  (benchmarked, approval-gated), `evolution_experiments`, `evolution_identity_traits`,
  `evolution_audit`.
- **Organism (persistent life):** `organism_state`, `continuity_snapshots`,
  `identity_profiles`, `dream_cycles`, `cognitive_health`, `energy_usage`,
  `goal_history`, `organism_mutation_history`, `immune_events`, `research_sessions`,
  `organism_world_model`, `organism_subbrains`.
- **Vision/perception:** `visual_memory`, `visual_regions`, `visual_workflow_states`.
- **Agentic audit:** `agent_audit` (append-only, gates the future permission allowlist).

> **Dual-DB note:** the Tauri shell keeps a *separate* Rust SQLite under the OS
> app-data dir. Data needed by both web + desktop must route through the Node
> server, not Tauri commands (see CLAUDE.md).

---

## §9 — Agent Orchestration Logic

Three orchestration layers, isolated so a misbehaving agent never blocks boot
(`agents/runtime.ts` wraps each init; `index.ts:111` swallows brain-core failure):

1. **TS agentic layer** (`agents/`): `brainCore.ts` starts observer / summary /
   scheduler / system-sensor agents over a shared `Agent` base + `runtime`. They
   watch files/activity and emit `summary-created`, `activity-observed`,
   `agent-status` over the bus. Booted by `startBrainCore()`.
2. **Phase-2 organism subsystems** (`core/`): `organism` (lifecycle/goals/energy/
   health/immune), `swarm` (sub-brain coordination), `evolution` (component
   mutation under benchmark gates), `imagination` (future simulation). Each has a
   router (`/api/{organism,swarm,evolution,imagination}`) and a `safety.ts` gate;
   all writes pass through approval/reversibility flags.
3. **Civilization** (`civilization/`, opt-in `CIVILIZATION_ENABLED=false`):
   multi-brain peer discovery, collective memory/goals, governance, culture — the
   "distributed cognition" tier.

**Orchestration invariants:** allow-all today but every gated action is logged to
`agent_audit`; safety gate + reversibility on every mutation; nothing autonomous
runs outbound network by default.

---

## §10 — Visualization System

`NeuralGraphRenderer` (`src/components/NeuralGraph.tsx`) packs **all** neurons
into one `InstancedMesh`, all pathways into one `LineSegments` with per-vertex
colors, and all pulses into a second `InstancedMesh`. Hiding a region writes a
zero-scale matrix (not `visible=false`). Only invisible region-volume meshes
(`regionMeshes`) are raycast for clicks.

**The non-negotiable boundary:** simulation buffers are mutated in place every
frame outside React; `BrainScene` calls `simulation.step(delta, elapsed)` then
`graphRenderer.update(...)`. Config changes route through `simulation.setX(...)`
methods, never per-frame React state. Auto-quality (`useAutoQuality` /
`adaptiveQuality` / `performancePresets`) scales neuron/pulse counts to hold
60 FPS.

**Two region taxonomies** (keep straight): ~30 *anatomical* IDs (`types.ts` /
`regionDefinitions.ts`) drive the 3-D scene; 8 *logical* cortices
(`LogicalRegionId`) come from the server and are expanded to anatomical IDs via
`LOGICAL_REGION_MAP` for "routing" flashes.

What's visualized: region/pathway intensity, membrane-potential heatmap,
travelling pulses, neuromodulator scalars, oscillation phase, burst + memory
traces, and pipeline routing. The prompt's "holographic/sci-fi" aesthetic lives
in `BrainVisualEffects.ts` (bloom via `UnrealBloomPass`).

> **Engine selection** (`BrainScene.tsx`): default `SignalSimulation`; append
> `?useSpiking=true` for `AdvancedBrainCore`; `?useHybrid=true` for the full
> `HybridCognitiveCore`. All three satisfy the same `BrainSimulation` interface,
> so the renderer is engine-agnostic.

---

## §11 — Continuous Cognition Loop

The prompt's `while alive:` is realized as **loops at four cadences**:

| Cadence | Driver | Does |
|---------|--------|------|
| ~60 Hz (per frame) | `HybridCognitiveCore.step` via `BrainScene` rAF | perceive→associate→predict→arbitrate→reinforce→meta-learn; 8 fixed sub-steps of 0.5 ms neural ODE |
| ≤10 Hz (budgeted) | System-2 arbitration | deliberate when uncertainty ≥ threshold, ≤2.5 ms/frame |
| seconds–minutes | `scheduleDecayTick` (boot), twin snapshots, agents | decay/consolidation, system snapshots, observation |
| minutes–session | `organism` lifecycle, `dream_cycles`, civilization | goals, sleep/dream consolidation, peer cognition |

**Gap → idle cognition (🟡):** there is no server-side autonomous reasoning pass
that fires *without* a user prompt (true "idle thinking" / internal monologue).
The clean seam: add an idle-tick agent in `agents/` that, on a quiet timer,
samples high-activation memories, runs a short reasoning pass, and emits its
trace over the bus — reusing `consolidationEngine` + `imagination` rather than
new infrastructure (§17).

---

## §12 — Scalable Deployment Plan

Local-first, scaling outward only when a real need appears:

1. **Tier 0 — Dev (today):** `npm run dev:all` (Vite 5173 + Express 8787) +
   any local LLM runtime. Zero outbound traffic.
2. **Tier 1 — Desktop:** `npm run tauri:build` → single MSI/NSIS bundle; strict
   CSP locks `connect-src` to the 7 runtime loopback URLs + local server.
3. **Tier 2 — Heavy compute sidecar:** activate `worker/` (Python) **only** when
   embedding/rerank volume or Whisper/vision exceed Ollama — Node calls it over
   loopback HTTP. (Currently unwired by design.)
4. **Tier 3 — Distributed cognition:** flip `CIVILIZATION_ENABLED=true` to let
   multiple brains discover peers and share collective memory/goals over LAN.
5. **Tier 4 — GPU acceleration (aspirational):** move the Izhikevich integrator +
   CSR propagation to a **WebGPU compute shader** (the buffers are already
   Float32Arrays / CSR — GPU-friendly); offload the spiking loop to a Web Worker
   to free the main thread (already noted in the spiking plan).

**Concurrency & memory management:** the engine is allocation-conscious (reused
scratch buffers, capped pulse pool `MAX_PULSES`); server background work is
timer-driven and never blocks request handling; agents are isolated; SQLite WAL
allows concurrent reads. Scale knobs: `adaptiveQuality`, `MAX_FILES_PER_SCAN`,
`MAX_FILE_BYTES`, sub-step count.

---

## §13 — API Architecture

Express, all under `/api`, mounted in `index.ts`:

| Router | Surface |
|--------|---------|
| `health` | `/api/health` (db/vector/locality status) |
| `memory` | CRUD + search over `memory_points`/`memory_relations` |
| `scan` | `POST /api/scan/run` (+ WS progress) |
| `connectors` | list/create/select local LLM runtimes (local-URL guarded) |
| `ask` | **SSE** `POST /api/ask` — streams `PipelineEvent`s |
| `conversations` | dialogue history |
| `twin` / `swarm` / `imagination` / `evolution` / `organism` | Phase-2 subsystems |
| `vision` | perception capture/search |
| `phase2` / `civilization` | aggregate + multi-brain |

Plus **WS `/ws/brain`** (broadcast `BrainBusMessage`). Security posture: CORS
origin allowlist (Vite + Tauri origins only); non-GET `/api/*` requires the
`X-Brain-Local: 1` header; JSON body capped at 1 MB; loopback bind by default.

---

## §14 — Local-First Execution Model

Zero outbound traffic by default — enforced, not aspirational (full detail in
CLAUDE.md "Purely-local guarantees"):

- **URL allowlist:** `LOCAL_ONLY=true` (default) → `isLocalUrl()`
  (`util/network.ts`) rejects any non-loopback / non-RFC1918 connector base URL.
- **Auto-discovery:** `reconcileDiscovered()` probes 7 local runtimes (Ollama,
  LM Studio, llama.cpp, Jan, GPT4All, vLLM, TGI) every 60 s; Ollama preferred
  (native embeddings + streaming).
- **Embeddings fallback chain:** active connector → any healthy local Ollama →
  null (memory step degrades gracefully, pipeline still completes).
- **Tauri CSP:** `default-src 'self'`, `connect-src` = exactly the 7 runtimes +
  local server.
- **`LocalityBadge`:** green "Purely local" unless a remote connector is enabled.

To allow remote: `LOCAL_ONLY=false` + an OpenAI-compatible connector. The badge
flips amber and lists the offending URL.

---

## §15 — Autonomous Cognition Algorithms

The system's intelligence is in these concrete algorithms (all already coded
except where noted):

| Algorithm | Where | Essence |
|-----------|-------|---------|
| **Izhikevich integration** | `IzhikevichNeuron.ts` | `v' = 0.04v²+5v+140−u+I`, `u' = a(bv−u)`; 8 fixed 0.5 ms sub-steps/frame |
| **Synaptic propagation** | `RealisticConnectome.ts` | CSR sparse, O(spikes × out-degree); AMPA/NMDA/GABA conductances |
| **3-factor STDP** | `AdvancedBrainCore` §5 + `MemorySystem` | `Δw = ν·(A₊e^(−Δt/τ₊) − A₋e^(−Δt/τ₋))`, `ν` = dopamine gate |
| **Neuromodulation** | `NeuromodulationSystem.ts` | DA/ACh/5-HT/NE scale excitability + plasticity + exploration |
| **Predictive coding / free energy** | `PredictiveCodingEngine.ts` | prediction error → bottom-up drive (`PE_SCALE`) |
| **Oscillations + cross-freq coupling** | `BrainOscillations.ts` | theta/alpha/beta/gamma, PING gamma, theta-gamma PAC |
| **Criticality homeostasis** | `BrainDynamics.ts` | self-tunes toward σ≈1 (edge of chaos) |
| **Arbitration (System 1↔2)** | `HybridCognitiveCore.computeUncertainty` | `u = 0.5·freeE + 0.25·RPEvol + 0.15·critDrift + 0.1·arousal` |
| **Reinforcement / affect** | `ReinforcementSystem.ts` | RPE → dopamine → plasticity; valence/arousal circumplex |
| **Meta-learning** | `MetaLearningSystem.ts` | genome evolution within `GENOME_BOUNDS` + EWC + IQ (with held-out anti-Goodhart probe) |
| **Ebbinghaus decay + reinforcement** | `memoryStrength.ts` | usage-reinforced forgetting curve |
| **Spreading activation** | `accessPatternTracker.ts` | co-access graph propagation |
| **Novelty detection** | `noveltyDetector.ts` | surprise scoring for attention/encoding |
| **Consolidation + replay** | `consolidationEngine.ts` + `replayService.ts` | promote/archive + theta-paced hippocampal→neocortical replay |
| **Imagination simulation trees** | `core/imagination.ts` | branch candidate futures, score risk/confidence, reflect vs reality |
| **Evolution under benchmark gate** | `core/evolution.ts` | mutate component → benchmark → approve/rollback |
| **Unified saliency** 🔴 | *proposed* `attention/saliency.ts` | `attention = w₁·novelty + w₂·goalRel + w₃·emotion + w₄·survival` |

---

## §16 — Real-Time Processing Pipeline

Hard real-time on the render thread is the central constraint:

- **Frame budget:** System 1 is the only per-frame-heavy work; System 2 is
  time-sliced under a hard `SLOW_FRAME_BUDGET_MS = 2.5`; meta-learning runs only
  with leftover budget; persistence writes are throttled (≥15 s).
- **Fixed-substep integration:** `FIXED_SUBSTEPS = 8 × SUB_DT = 0.5 ms` →
  4 ms sim-time/frame, keeping neurons in Euler's stability region and synced to
  theta.
- **Allocation discipline:** reused scratch buffers; capped pulse pool
  (`MAX_PULSES = 260`, `MAX_NEW_PULSES_PER_FRAME = 10`).
- **Adaptive quality:** `useAutoQuality`/`adaptiveQuality` scale density to hold
  60 FPS.
- **Server-side real-time:** SSE streams tokens as generated; WS fans out events
  immediately; background ticks are decoupled from request latency.
- **GPU/Worker headroom (aspirational):** WebGPU compute for the integrator;
  Worker offload for the spiking loop.

---

## §17 — Gap Ledger & Sequenced Roadmap

**Consolidated gaps** (only the genuine ones):

| Gap | Module | Severity | Seam |
|-----|--------|----------|------|
| `AdvancedBrainCore`/`HybridCognitiveCore` not visually verified | 9, 11 | 🧪 **blocker** | `?useSpiking`/`?useHybrid` + `cdp-shot.mjs` |
| `verify:canvas` gate broken (selects extension page) | tooling | 🔴 **blocker** | `scripts/verify-canvas.mjs` → pick `type==="page"` |
| No unified saliency scorer | 2 (Attention) | 🟡 | new `attention/saliency.ts` |
| No idle/internal-monologue cognition | 4 (Thought loop) | 🟡 | new idle-tick agent in `agents/` |
| Graph-traversal retrieval not fused into ranker | 3/6 (Memory) | 🟡 | PPR over `memory_relations` → `reasoning/ranker.ts` |
| Twin forecaster is statistical, not sequence model | 6 (Predictive) | 🟡 | `twin/predictiveModel.ts` → small GRU |
| Whisper/video perception unwired | 1 (Perception) | 🟡 | `worker/` + `/api/perceive` |
| No explicit 6-level abstraction ladder | 11 (Hierarchy) | 🟡 | type `cognitive_abstractions.level` |
| Causal maps implicit | 7 (World model) | 🟢 nice-to-have | promote imagination transitions to a causal graph |

**Phased plan** (extends the 2026-05-22 roadmap):

- **Phase 0 — Verify the foundation (do first).** Fix `verify:canvas`; visually
  confirm `?useSpiking=true` and `?useHybrid=true` paint via `cdp-shot.mjs`; add a
  green-build gate (frontend `tsc` + server `typecheck` + a render check) so
  regressions can't recur. *This unblocks everything else.*
- **Phase 1 — Close the two highest-leverage cognitive gaps.** (a) Unified
  `attention/saliency.ts` folding novelty + goal-relevance + emotion + survival
  into one score that drives both retrieval and engine drive. (b) Idle-cognition
  agent for true continuous thought without prompts.
- **Phase 2 — Memory & prediction depth.** Personalized-PageRank graph retrieval
  fused into the ranker; GRU upgrade for the twin sequence model.
- **Phase 3 — Perception & hierarchy.** Wire `worker/` for Whisper/vision; add an
  explicit abstraction `level` to clusters/abstractions.
- **Phase 4 — Scale (only on real need).** WebGPU/Worker for the spiking loop;
  civilization multi-node; HNSW only if `sqlite-vec` latency demands it.

---

## §18 — Extended Module Set (the 22-module / 20-deliverable framing)

> This section extends §1–§17 to the larger brief (22 modules, 20 output
> requirements). Most expand modules already covered above; the genuinely **new**
> framings get focused sub-sections (§18.1–§18.11). Nothing here proposes a new
> stack — it maps the expanded vision onto the same code and names the new gaps.

### Master map — all 22 expanded modules

| # | Module (expanded brief) | Status | Where / cross-reference |
|---|--------------------------|--------|--------------------------|
| 1 | Cognitive Energy System | 🟡 | frame budget (`HybridCognitiveCore` `SLOW_FRAME_BUDGET_MS`) + organism energy (`energy_usage`, `core/organism.ts`) → **§18.1** |
| 2 | Multi-Layer Perception | 🟡 | §3 #1 (`vision/`, `scanner/`, `speechInput`) |
| 3 | Attention Engine | 🟡 | §3 #2; expanded formula adds an `uncertainty` term → **§18.2** |
| 4 | Associative Neural Memory (+ subconscious latent) | ✅ / 🟡 | §6; "subconscious latent memory" = low-strength/archived tier (🟡) |
| 5 | Neuroplasticity | ✅ | STDP + BCM metaplasticity + pruning → **§18.3** |
| 6 | Continuous Thought Loop | 🟡 | §11 (idle-monologue gap) |
| 7 | Competing Thought Systems | 🟡 | System 1↔2 arbitration only; N-way streams = gap → **§18.4** |
| 8 | Emotional Computation | ✅ | §3 #5 (neuromod + valence/arousal) |
| 9 | Curiosity-Driven Exploration | 🟡 | `curiosityWeight`/`explorationTemp` genome + `noveltyDetector`; self-initiation gap → **§18.5** |
| 10 | Predictive Cognition | ✅ | §3 #6 (`PredictiveCodingEngine`, `imagination`) |
| 11 | World Model | 🟡 | §3 #7 (`twin/`, `organism_world_model`) |
| 12 | Self-Model / Identity | ✅ | §3 #8 (persistence + `identity_profiles`) |
| 13 | Meta-Cognition | ✅ | `MetaLearningSystem` + `error` step + held-out probe → **§18.6** |
| 14 | Temporal Cognition | 🟡 | temporal patterns + `temporal-engine` crate + 4 cadences; future-self sim gap → **§18.7** |
| 15 | Hierarchical Abstraction | 🟡 | §3 #11 (`semanticCluster`, `cognitive_abstractions`) |
| 16 | Subconscious Processing | ✅ | background ticks reframed → **§18.8** |
| 17 | Dream / Sleep Simulation | ✅ | §3 #10 (`replayService`, `dream_cycles`, imagination dreams) |
| 18 | Multi-Speed Cognition | ✅ | §11 (four cadences) |
| 19 | Self-Preservation Dynamics | ✅ | `cognitive_health` + `immune_events` + EWC → **§18.9** |
| 20 | Hybrid Reasoning | ✅ | neural + symbolic + graph + causal + probabilistic → **§18.10** |
| 21 | Cognitive Ecology (faculty agents) | 🟡 | faculties exist as modules; negotiating-agents framing = gap → **§18.11** |
| 22 | Real-Time Neural Visualization | ✅ | §10 |

**Tally:** 9 ✅, 13 🟡, 0 🔴. Every expanded module has a real seam; the 🟡s are
*missing capabilities within built modules*, not absent modules.

### §18.1 Cognitive Energy System — 🟡

Energy already constrains cognition in **two** places, but not as one unified
budget. (a) **Engine:** System 2 runs under a hard `SLOW_FRAME_BUDGET_MS = 2.5`
and meta-learning only spends leftover budget — higher-priority work (System 1)
literally suppresses lower-priority cognition each frame (`HybridCognitiveCore.step`).
(b) **Server:** `core/organism.ts` debits an energy budget per task into
`energy_usage`, with `cognitive_health.resource_balance` tracking it.
**Gap:** these aren't a single ledger, and there's no *attention fatigue* curve
that decays focus capacity with sustained load. **Fill:** a `cognition/energy.ts`
that exposes one budget consumed by attention, reasoning depth, and prefetch, with
a fatigue term feeding the §18.2 saliency score.

### §18.2 Attention Engine (expanded formula) — 🟡

The expanded brief's score adds `uncertainty` to the earlier four terms:
`attention = novelty + goal_relevance + emotional_weight + uncertainty +
survival_importance`. Every term has a source already — novelty
(`noveltyDetector`), emotion (neuromod tone + affect arousal), uncertainty
(`HybridCognitiveCore.computeUncertainty` free-energy term), survival
(`cognitive_health`/`immune` load). **Gap (unchanged from §17):** no single scorer
combines them to *gate* memory activation + reasoning depth + energy. This is the
same proposed `attention/saliency.ts`, now with the 5th term.

### §18.3 Neuroplasticity — ✅

"Fire together, wire together" is literally implemented: dopamine-gated trace-based
**STDP** on spiking edges (`AdvancedBrainCore` step §5; `STDP_LTP/LTD`, `TRACE_TAU`),
weights bounded `[W_MIN, W_MAX]`. Pruning/strengthening of *durable* associations
runs on `memory_relations.weight` + `accessPatternTracker`. **Metaplasticity**
(plasticity of plasticity) is a BCM-style sliding threshold in
`MetaLearningSystem` (job 3). Abstraction emergence → `semanticCluster` +
`cognitive_abstractions`. Topology evolution → `core/evolution.ts`.

### §18.4 Competing Thought Systems — 🟡

Today the competition is **two-way**: System 1 (intuitive spiking) vs System 2
(deliberate), resolved by the arbiter's uncertainty threshold (§5/§15). Within
System 2, `ReasoningEngine` runs analogy/counterfactual/theory-of-mind operators
but *aggregates* them rather than letting them compete. At the macro scale,
`core/swarm.ts` + `organism_subbrains` coordinate specialized sub-brains.
**Gap:** no N-way thought-cluster competition (exploration-vs-caution,
short-vs-long-term) with a confidence/emotion/prediction-weighted resolver.
**Fill:** promote the reasoning operators to scored, competing proposals resolved
by a softmax over (confidence × emotional weight × survival relevance) — reusing
the affect + criticality signals already on the bus.

### §18.5 Curiosity-Driven Exploration — 🟡

Curiosity is parameterized (`curiosityWeight`, `explorationTemp` in the genome,
evolved by `MetaLearningSystem`) and drives the "reach for a distant association"
creativity route in `ReasoningEngine`. Rising prediction uncertainty already
raises System-2 engagement. **Gap:** the system doesn't *self-initiate* an
exploration action (e.g. proactively scan an unindexed dir, or open a low-coverage
memory cluster) when curiosity is high — it stays reactive. **Fill:** wire the
curiosity signal to the proposed idle-cognition agent (§11) so high uncertainty
schedules an exploratory `scan`/retrieval pass.

### §18.6 Meta-Cognition — ✅

`MetaLearningSystem` is the "thinking about thinking" engine: a composite **IQ**
from six z-scored sub-scores (prediction accuracy, stability, problem-solving,
adaptation speed, creativity, reasoning depth) plus a **held-out probe excluded
from fitness** (anti-Goodhart self-honesty). Confidence estimation lives on every
`ReasoningResult.confidence`; contradiction/coherence checking is the pipeline's
`error` step (contradictions / missing-info / confidence JSON). Bias detection =
the probe canary. Self-debugging seam = `evolution_audit` + benchmark gates.

### §18.7 Temporal Cognition — 🟡

Multi-scale time is real: ms (neural sub-steps) → seconds (frames) →
minutes (background ticks) → session/lifetime (`continuity_snapshots`, IQ history).
`memory_temporal_patterns` weights memories by hour-of-day; `twin` reasons over
time-series; `crates/temporal-engine` (+ `computer-brain/crates/temporal-engine`)
exist for richer temporal logic. **Gap:** "future-self simulation" and an explicit
identity-evolution timeline aren't first-class — identity drift is recorded but not
projected forward.

### §18.8 Subconscious Processing — ✅

The "below conscious awareness" tier is the set of **background ticks** that run
without a prompt: `consolidationEngine` decay + spreading activation (the two
`decayHandles` intervals in `index.ts`), `replayService` reactivation,
`noveltyDetector`/anomaly scans, `semanticCluster` latent grouping. They influence
"conscious" cognition indirectly by reshaping `importance`/`memory_relations`
weights that the next retrieval reads. This is exactly the brief's subconscious
model — it's simply already the background half of the system.

### §18.9 Self-Preservation Dynamics — ✅

Three layers protect coherence: (a) **knowledge** — EWC anti-catastrophic-forgetting
in `MetaLearningSystem` (job 4) pulls important synapses back toward a checkpoint;
(b) **memory/identity** — `cognitive_health` scores memory_integrity /
identity_coherence / reasoning consistency, `immune_events` log + resolve threats,
`organism` lifecycle can enter recovery; (c) **stability** — `BrainDynamics`
homeostasis holds criticality near σ≈1 so cognition neither dies out nor seizes.
Contradiction repair seam = the `error` step + immune response.

### §18.10 Hybrid Reasoning — ✅

The name `HybridCognitiveCore` is literal — it fuses five reasoning substrates,
*not* just LLM tokens: **neural** (Izhikevich spiking System 1), **symbolic**
(`ReasoningEngine` operators — deterministic, no LLM in-loop), **graph**
(`memory_relations` traversal + spreading activation), **causal** (`imagination`
transition simulation), and **probabilistic** (learned `ranker` + free-energy
predictive coding). The LLM (`reasoning/pipeline.ts`) informs the brain over the
bus but is one voice among five — satisfying "do not rely only on token prediction."

### §18.11 Cognitive Ecology — 🟡

The brief wants named faculty-agents (Memory / Emotion / Prediction / Reflection /
Planning / Attention / Curiosity / Identity) that cooperate, compete, negotiate.
**The faculties already exist as modules** — `MemorySystem` (Memory),
`ReinforcementSystem` (Emotion), `PredictiveCodingEngine` (Prediction),
`ReasoningEngine` (Reflection), `core/organism` (Planning), the attention pieces
(Attention), the curiosity genome (Curiosity), `persistence`/`identity_profiles`
(Identity). **Gap:** they're composed by *delegation* inside `HybridCognitiveCore`,
not as autonomous agents that bid/negotiate over a shared blackboard. **Fill:**
this is the same mechanism as §18.4 — give each faculty a scored proposal channel
on `BrainEventBus`; the arbiter becomes the negotiation resolver. Low-risk because
the faculties and the bus already exist; only the protocol is new.

### §18.12 — The 20 output requirements → where answered

| # | Output requirement | Section(s) |
|---|---------------------|-----------|
| 1 | Full architecture | §1 |
| 2 | Folder structure | §2 |
| 3 | Event-driven cognition framework | §7, §4(a) |
| 4 | Database schema | §8 |
| 5 | Agent orchestration system | §9, §18.11 |
| 6 | Neural graph propagation logic | §6, §15 (CSR/STDP/spreading) |
| 7 | Continuous cognition loops | §11, §4(a) |
| 8 | Visualization engine | §10 |
| 9 | API architecture | §13 |
| 10 | Local-first execution | §14, Appendix A |
| 11 | Distributed cognition system | §9 (civilization/swarm), §12 Tier 3 |
| 12 | GPU optimization strategies | §12 Tier 4, §16 |
| 13 | Concurrency models | §12, §16 (frame budget / timer ticks / WAL / worker offload) |
| 14 | Memory management system | §6, §16 (buffers/pulse pool) |
| 15 | Neuroplasticity algorithms | §15, §18.3 |
| 16 | Dream simulation framework | §3 #10, §18.8 |
| 17 | Meta-cognition systems | §18.6 |
| 18 | Cognitive energy management | §18.1 |
| 19 | Temporal reasoning framework | §18.7 |
| 20 | Production-grade deployment plan | §12 |

### §18.13 — New gaps folded into the §17 roadmap

The expanded brief adds four gaps to the ledger; they cluster onto the existing
phases (no new phase needed):

| New gap | Module | Where it lands |
|---------|--------|----------------|
| Unified cognitive-energy ledger + attention fatigue | §18.1 | **Phase 1** (pairs with the saliency scorer) |
| 5-term saliency (adds `uncertainty`) | §18.2 | **Phase 1** (the same `attention/saliency.ts`) |
| N-way competing thought streams + negotiation protocol | §18.4 / §18.11 | **Phase 1–2** (one mechanism serves both; build on `BrainEventBus`) |
| Curiosity self-initiation + future-self simulation | §18.5 / §18.7 | **Phase 1** (idle agent) / **Phase 3** (temporal) |

**One mechanism unlocks three modules:** a scored-proposal protocol on
`BrainEventBus` (faculties emit bids; the arbiter resolves by confidence × emotion
× survival) simultaneously delivers Competing Thought Systems (§18.4), Cognitive
Ecology (§18.11), and the negotiation half of Attention (§18.2). That's the
highest-leverage single addition the expanded brief implies — and it reuses the
bus, the affect signals, and the arbiter that already exist.

---

## Appendix A — Suggested stack → local equivalent (why we don't pivot)

| Prompt suggests | This repo uses | Why the substitution holds |
|-----------------|----------------|----------------------------|
| Neo4j (graph memory) | `memory_relations` + `memory_access_patterns` in SQLite | weighted/typed edges + spreading activation, no external daemon, survives `LOCAL_ONLY` |
| Qdrant (vector memory) | `sqlite-vec` (`memory_vec`) | ANN at personal scale (<100k); HNSW deferred to Phase 4 |
| Redis / Kafka (event streaming) | `BrainEventBus` + WS hub + `core/eventBus` | in-process + WS fan-out; no broker; same typed-message guarantee |
| FastAPI (API) | Express + TS (`server/`) | one process for API + WS + cognition; strict TS contracts shared with the client |
| Unreal Engine 5 (viz) | Three.js + WebGPU-ready renderer | runs in the same app, no native build, instanced GPU rendering |
| Python core orchestration | TypeScript (`server/`) + Rust (`crates/`, `computer-brain/`) | one type system across tiers; Rust for the heavy crates |
| Whisper (speech) | `src/engine/speechInput.ts` now; `worker/` later | browser speech today; Python sidecar when volume justifies it |

Each substitution preserves the project's defining property: **end-to-end local
execution with zero outbound traffic by default.** Adopting the suggested stack
would forfeit that and duplicate working subsystems — which is why this blueprint
extends the existing engine instead of replacing it.
