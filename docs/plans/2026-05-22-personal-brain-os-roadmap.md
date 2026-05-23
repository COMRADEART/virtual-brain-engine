# Personal Brain OS — Grounded Roadmap

> Written after a full repository audit + repair session (2026-05-22). The goal
> of this doc is to map the **Personal One-on-One Computer Brain** vision onto
> what the codebase *actually* contains today, separate real from aspirational,
> and sequence the work. Read the code for "what is"; read the SPEC files for "why".

## Context (why this exists)

The grand vision (file-system-as-memory, hybrid retrieval, biologically-plausible
spiking visualization, MoE router, digital twin, sleep consolidation) was
requested as if extending a working engine. The audit found the opposite:

- **The committed baseline did not compile.** `HEAD` (`e9f84b5`) had **315
  TypeScript errors** on the frontend (307 in `BrainVisualEffects.ts`). The two
  "neuroscience upgrade" commits shipped non-compiling code. There is no
  green-build gate (`npm run build` has been failing silently).
- The working tree was a **half-finished repair** mid-migration from the scripted
  `SignalSimulation` to a from-scratch LIF `SpikingEngine`, plus a half-wired
  memory-replay feature. Several files were corrupted (a Python `"""docstring"""`
  atop a `.ts` file; a frontend engine importing `server/` modules; a truncated
  object literal).

After repair (this session): **the app runs again** — backend healthy, frontend
renders the Brain OS UI + 3D brain — but on the *stable* `SignalSimulation` path.
**The LIF `SpikingEngine` is gated OFF** (`USE_SPIKING_ENGINE = false` in
`src/components/BrainScene.tsx`) because the rewrite **blocks the main thread on
mount** (the scene never paints). So requirement #3 (real spiking) is not active.

## What already exists vs. the six requirements

| # | Requirement | Status in repo today |
|---|-------------|----------------------|
| 1 | File-system-as-memory: embeddings + ANN, knowledge graph, forgetting curve | **Mostly built.** `server/src/scanner/*` indexes files → `MemoryPoint` + embedding; `db/sqlite.ts` + `sqlite-vec` does vector search; `memory_relations` is the graph; `memory/importanceScorer.ts` + `memoryStrength.ts` do Ebbinghaus decay + usage reinforcement. **Gap:** retrieval is brute-force `sqlite-vec`, **not HNSW/FAISS** — fine for personal scale (<100k items); HNSW is a future-scale optimization, not a current need. |
| 2 | Hybrid retrieval + learned ranker | **Partly built.** `reasoning/pipeline.ts` does vector + recency/importance boost; `reasoning/ranker.ts` + `rankerModel.ts` is a learned re-ranker. **Gap:** no graph-traversal retrieval (Personalized PageRank / weighted shortest-path) fused into ranking; ranker is lightweight, not LambdaMART/listwise. |
| 3 | Spiking propagation + pulse routing + particles | **Exists but broken.** `SpikingEngine.ts` (LIF + AMPA/NMDA/GABA + theta/gamma + STDP) matches the spec on paper; `IzhikevichNeuron.ts`, `BrainOscillations.ts`, `MemorySystem.ts` exist. **Blocking:** hangs the main thread; has duplicate class members + stub methods (`propagateSpike` is a no-op TODO). Pulse routing is currently weighted-random, not Dijkstra/A* priority-queue. |
| 4 | Central AI router / multi-agent (MoE) | **Not built as routing.** `agents/` (observer/summary/scheduler/sensor) and `core/{swarm,organism}` exist, but there is **no classifier/score-based router** dispatching queries to specialized region-experts. |
| 5 | Digital twin + sequence prediction (LSTM/GRU/Transformer) | **Partly built.** `twin/` collects state, forecasts, detects anomalies. **Gap:** `twin/predictiveModel.ts` is statistical, not a recurrent/transformer sequence model. |
| 6 | Memory layers + sleep consolidation (replay + pruning) | **Mostly built (now compiles).** `consolidationEngine.ts` (promote/consolidate/archive/decay), `noveltyDetector`, `predictivePrefetch`, `accessPatternTracker`, `thresholdController`. Replay (`replayService.ts`) was wired in half-finished — **fixed this session** (compiles + broadcasts `replay` events end-to-end). |

**Takeaway:** ~60% of the vision already has real implementations. The work is
less "build from scratch" and more "stabilize, then fill 3 genuine gaps (#3 fix,
#4 router, #5 sequence model)."

## Phased plan

### Phase 1 — Stabilize the foundation (do first; nothing else is safe on a broken base)
1. **Fix the `SpikingEngine` main-thread hang.** Profile the constructor/`step()`.
   Likely causes: O(N×synapses) synchronous init/step at full density, and/or a
   loop that never yields. Remedies: cap neuron/synapse counts via the existing
   `adaptiveQuality`/`performancePresets`; move the integrator to fixed sub-stepping
   with a budget; consider a Web Worker (the spiking plan already lists this).
   Remove the duplicate `nmdaMgBlock`/`propagateSpike` members; implement
   `propagateSpike` (currently a no-op). Re-enable `USE_SPIKING_ENGINE` only after
   `cdp-shot.mjs` shows a painted canvas with the LIF engine.
2. **Drive `npm run build` to zero errors.** ~74 frontend type errors remain
   (server is already at 0). Clusters: `BrainVisualEffects.spike_ext.ts` (26 — an
   importless fragment; either integrate into `BrainVisualEffects.ts` or remove),
   `SpikingEngine.ts` (~17), `BrainScene.tsx`, `MemoryBrainBridge.ts`,
   `MemorySystem.ts`, `IzhikevichNeuron.ts`, `BrainOscillations.ts`.
3. **Fix the broken quality gate.** `scripts/verify-canvas.mjs` connects to
   `tabs[0]` from `/json/list`, which is the Chrome **extension background_page**,
   not the app — so it has been falsely reporting "missing canvas". Fix: select
   `tabs.find(t => t.type === "page")` (see `scripts/cdp-shot.mjs`, which works).
4. **Add a green-build gate** (pre-commit or CI running `tsc` on both halves +
   `cdp-shot`) so the 315-error situation can't recur.

### Phase 2 — Close the algorithmic gaps (after Phase 1 is green)
- **#4 MoE router:** add `server/src/reasoning/router.ts` — a score-based classifier
  that maps a query to logical-region "experts" (reuse `LogicalRegionId` +
  `LOGICAL_REGION_MAP`), emits the chosen regions as `PipelineEvent.logicalRegions`
  so the brain visibly "routes" to the right cortex.
- **#2 graph retrieval:** add Personalized PageRank / weighted traversal over
  `memory_relations` and fuse its score into `reasoning/ranker.ts`.
- **#5 sequence model:** upgrade `twin/predictiveModel.ts` to a small GRU (or keep
  stats + add a lightweight next-action GRU) for behavior prediction.
- **#3 pulse routing:** replace weighted-random pulse spawning with a priority-queue
  (Dijkstra/A*) router on the neural graph once the LIF engine is stable.

### Phase 3 — Scale + polish (only if real need appears)
- HNSW/FAISS via the `worker/` Python sidecar **only** if the memory count and
  latency justify it (currently 7020 memories; sqlite-vec is ample).
- Web-worker the spiking integrator; richer particle systems driven by spike state.

## Key files
- Toggle: `src/components/BrainScene.tsx` (`USE_SPIKING_ENGINE`).
- Spiking: `src/engine/SpikingEngine.ts`, `BrainVisualEffects.ts`, `*.spike_ext.ts`.
- Memory ML: `server/src/memory/*` (the integration seam is `consolidationEngine.ts`).
- Retrieval/ranker: `server/src/reasoning/{pipeline,ranker,rankerModel}.ts`.
- Contracts: `shared/pipeline.ts` (added a `replay` `BrainBusMessage` variant).
- Working render check: `scripts/cdp-shot.mjs`.

## Verification
- Backend: `curl http://127.0.0.1:8787/api/health` → `db:ok, vector:ok`.
- Frontend render: `npm run dev` then `node scripts/cdp-shot.mjs` → expect
  `canvases:1, hasWebGL:true, exceptions: none` and inspect `artifacts/render-check.png`.
- Type safety: `npx tsc --noEmit` (frontend) and `npm --prefix server run typecheck`.
