# STAR — Cognitive-Architecture Review & Loop-Closure Roadmap

*Architectural review of the `star` repository treated as a developing biological brain. Generated 2026-06-17. Methodology: three parallel read-only subsystem audits (biological cognition; software/performance/data; frontend/Rust/autonomy) cross-checked against the code, with the highest-stakes claims verified directly against source.*

> This document is a review + roadmap. It does **not** rewrite the project. The recommendations are scoped to **close existing loops, activate built-but-dormant features, and harden the substrate** — never to duplicate functionality that already ships.

---

## Central finding

**STAR is a near-complete cognitive *measurement & modeling* engine.** ~90% of the requested AGI capability checklist already exists as real, wired code: neuromodulators, predictive-processing surprise, MoE routing, episodic segmentation + episodic→semantic sleep distillation, Hebbian plasticity, attention saliency, info-gain curiosity (noisy-TV-immune), goal hierarchies, belief revision, procedural memory, a causal world model, 9-stage development, self-model calibration, an 8-emotion read-model, cognitive DNA, an energy/organism lifecycle, and an immune system.

**The gap is not breadth — it is *closure and activation*:**
1. Many signals are **computed then ignored** (surprise measured but not acted on; imagination simulates but never decides; energy tracked but never gates compute).
2. The richest capabilities are **built but default-OFF** with no maturation arc to earn them.
3. The whole brain runs on **one blocking event loop** with **no longitudinal self-telemetry**.
4. It evolves *data* but not *code* — the self-modification ceiling.

A note on rigor: two audit claims were checked and **corrected** before scoring. `core/safety.ts`'s allow-all is a *documented deferred hook* over autonomous agents that provably never reach an effector (the real dangerous-action gate, `actions/executor.ts`, is fully enforced) — **not** a vulnerability. And ranker state persists in `ranker_state`, not in-memory. The schema is also heavily indexed (~70 indexes); the one real indexing gap is the absence of FTS (keyword search is a leading-wildcard `LIKE` scan).

---

## Scores (0–100)

| # | Dimension | Score | Justification |
|---|-----------|-------|---------------|
| 1 | Overall architecture | **78** | Extraordinary breadth + disciplined seams; dragged by open loops, single-thread substrate, two disconnected brains. |
| 2 | Cognitive realism | **82** | Sophisticated modeling; loses points because cognition is largely *measured, not enacted*, and the richest features are off. |
| 3 | Biological realism | **74** | Strong neuro-grounding (neuromodulators, Hebbian, sleep, predictive coding) but baseline no-ops, advisory energy, 10-min "conscious" cadence, no active inference, no spatial/object-permanence. |
| 4 | Software engineering | **80** | `strict` TS, failure-isolation everywhere, huge hermetic selfcheck gate, idempotent schema; loses points for sync-DB blocking, no observability, hard-wired modularity. |
| 5 | AI architecture maturity | **80** | MoE routing, RAG+RRF, learned ranker + reranker, contextual bandit, online learning; loses points because RL/adaptive/evolution ship OFF and reward is sparse (single-user). |
| 6 | Scalability | **62** | Single process, single event loop, sync better-sqlite3, O(clients) WS fan-out, `LIKE` scans, render ceiling; distribution exists but off/unproven. |
| 7 | Maintainability | **76** | Strong conventions + per-subsystem selfchecks, but ~50 tables / dozens of subsystems / 30+ routers is heavy load; two Rust workspaces with overlapping names. |
| 8 | Extensibility | **79** | Clean `shared/` contracts, router-per-subsystem, dynamic skills + MCP; loses points for no dynamic module registration and the orphaned Rust path. |
| 9 | Safety | **84** | Strong: LOCAL_ONLY egress gate, permissioned executor (allowlist + zod + confirm token + audit), injection fencing, redaction; loses points for no *cognitive/ethical* self-evaluation + runtime-mutable LOCAL_ONLY. |
| 10 | Performance | **66** | Real wins (fast-mode, adaptive compute, keep-alive, parallel embeds) but sync-DB hot path, fire-and-forget turbovec, `LIKE` scans, fan-out are real ceilings. |

---

## The 6 systemic weaknesses (root-cause)

1. **Open loops** — surprise measured but not acted on (no active inference); imagination simulates but never feeds decisions; energy tracked but never gates compute; metacognition flags low confidence but defers; neuromodulator baselines are no-ops.
2. **Dark features** — theory-of-mind, narrative grounding, imagination, creativity, evolution loop, adaptive controller, civilization all built but default-OFF; no maturation arc earns them.
3. **Single-threaded substrate** — all cognition on one Node event loop with synchronous SQLite; blocking retrieval + O(clients) fan-out + `LIKE` scans cap concurrency (~5–10 users) and corpus size.
4. **Two disconnected brains** — Node brain vs. Rust `crates/` (Phase 2) + `computer-brain/` (28 crates) are architecturally orphaned; browser builds get empty stubs. Dead-weight/duplication risk.
5. **Observability blind spot** — no structured logs/metrics/tracing; errors live in an in-memory counter that resets on restart. Self-improvement needs self-telemetry.
6. **Self-modification ceiling** — evolves *data* (genome JSON, ranker weights, beliefs) but not *code*; no hypothesis→implementation→test→deploy path.

---

## Roadmap

Each item: Problem · Root cause · Proposed architecture · Integration · Files · Data flow · Testing · Impact · Complexity · Risk. Every recommendation honors project law: flag-gated (default OFF unless additive/safe), failure-isolated on `/api/ask`, a hermetic selfcheck wired into `scripts/gate.mjs`, plus a runtime check; local-first invariants (LOCAL_ONLY, allowShell) never auto-relaxed.

### CRITICAL

**C1 · Observability spine (self-telemetry).**
- *Problem:* No structured logs/metrics; errors reset in-memory on restart; no longitudinal view of the brain's vitals.
- *Root cause:* `console.*` + ad-hoc `surfaceError` counters (`util/diagnostics.ts`), no persistence/time-series/metrics.
- *Proposed architecture:* `observability/{logger,metrics,vitals}.ts` — structured JSON logger (console + size-rotated file under `data/logs/`, dependency-free); pure in-process metric registry (counter/gauge/histogram); a `brain_vitals` time-series sampled on a brainCore tick (pipeline p50/p95 latency, retrieval hits, mean confidence, neuromodulator levels, energy, active goals, stage, error counts by taxonomy). Persist error taxonomy to `diagnostics_log`.
- *Integration:* wrap `surfaceError`; `agents/brainCore.ts` tick → `sampleVitals()`; `reasoning/pipeline.ts` timings; new router; bus `brain-vitals`.
- *Files:* new `observability/*`, `routes/vitals.ts`, `shared/observability.ts`, migration `0014` (`brain_vitals` + `diagnostics_log`); edits to `util/diagnostics.ts`, `agents/brainCore.ts`, `index.ts`, `config.ts` (`OBSERVABILITY`, default ON), `scripts/gate.mjs`.
- *Data flow:* error → `surfaceError` → counter + `diagnostics_log` row + log line. tick → `sampleVitals()` → `brain_vitals` row + bus. `GET /api/brain/vitals?since=` reads series.
- *Testing:* `observability:selfcheck` (hermetic) + runtime `/api/ask` → `/api/brain/vitals`.
- *Impact:* Foundational — unblocks every self-improvement loop + ops visibility. *Complexity:* M. *Risk:* Low.

**C2 · Substrate unblock (non-blocking retrieval + FTS + bounded async).**
- *Problem:* Sync better-sqlite3 retrieval blocks the single event loop; `keywordSearch` is a leading-wildcard `LIKE` full scan; relation queries unbounded; turbovec mirror unbounded fire-and-forget.
- *Root cause:* single event loop + synchronous DB; no FTS; no `LIMIT`s; no worker-mirror backpressure.
- *Proposed architecture:* FTS5 `memory_fts` (contentless + sync triggers + backfill) created in a guarded loader mirroring `loadVectorExtension`, with a `LIKE` fallback; bound `getRelationsFor`/`listRelationsAmong`; backpressure the turbovec mirror (bounded queue, single in-flight, drop-oldest); optional flagged `worker_threads` read pool (`ASYNC_DB_READER`, OFF — measure first).
- *Integration:* `db/repositories/memory.ts`, `db/sqlite.ts`, `learning/turbovecClient.ts`.
- *Files:* edits to those three + `config.ts` flags + selfcheck. *(No migration — FTS lives in the guarded loader.)*
- *Data flow:* keyword query → `memory_fts MATCH` → hits (fallback `LIKE`). upsert → bounded turbovec enqueue.
- *Testing:* `substrate:selfcheck` (hermetic) + runtime keyword-search timing + concurrent `/api/ask`.
- *Impact:* Real concurrency + corpus headroom; kills the `LIKE` cliff. *Complexity:* M. *Risk:* Low (FTS/bounds); Medium (worker-thread, flagged).

**C3 · Active-inference loop (surprise → epistemic action) — the keystone.**
- *Problem:* `predictiveProcessing.ts` computes surprise + pulses NE, but the brain never *acts* to reduce predicted surprise. The free-energy-minimization loop is open.
- *Root cause:* surprise consumed only as an NE pulse + open-question note; no action selection over an epistemic menu.
- *Proposed architecture:* `reasoning/activeInference.ts` — from (predicted retrieval quality, saliency uncertainty, NE/ACh, energy) compute **expected free energy** per epistemic action and, above threshold, select the lowest-EFE action **from levers the pipeline already has** (broaden retrieval, augment web inside `hybridEnabled()`, spawn a curiosity goal, enqueue a workspace thought, defer-re-reason). Learn the policy (LMS, like `banditPolicy.ts`) with a **no-regression warm-start floor** (cold = heuristic exactly).
- *Integration:* `reasoning/pipeline.ts` memory step (reuse `heuristicMultiQuery`/`shouldAugment`/brainState `shouldBroadenRetrieval`), `predictiveProcessing.ts`, `attention/saliency.ts`, `core/neuromodulators.ts`, `core/organism.ts`, `core/goalManager.ts`, `core/workspace.ts`, `db/repositories/adaptive.ts` (brain_metadata, no migration).
- *Files:* new `reasoning/activeInference.ts`, `shared/activeInference.ts`; edits to `pipeline.ts`, `config.ts`+`settings/runtimeSettings.ts` (`ACTIVE_INFERENCE`, OFF), gate.
- *Data flow:* memory step → predict → high EFE → select action → execute via existing lever → record actual → learn. Shown as `· ai:<action>` in memory-step detail.
- *Testing:* `activeinference:selfcheck` (hermetic: EFE math, warm-start floor, egress safety, LMS update) + runtime on/off no-regression.
- *Impact:* Closes the #1 loop — passive surprise becomes directed epistemic foraging. *Complexity:* M–H. *Risk:* Medium (hot path; mitigated by warm-start floor + isolation + flag-OFF + egress gate).

### HIGH

**H1 · Homeostatic energy budget (energy actually gates cognition).**
- *Problem:* `CognitiveEnergy` is tracked/logged but never constrains the hot path (zero `energy` refs in `pipeline.ts`). The brain can't tire or self-pace.
- *Root cause:* energy is bookkeeping; no consumer reads `energy.current` to cap compute.
- *Proposed architecture:* `core/energyBudget.ts` (pure `energy → {maxRounds, retrievalK, mayRunOptional}`); pipeline/agent-loop/workspace read it to gate depth and whether expensive OPTIONAL subsystems fire, charging energy via the existing `consumeEnergy`; depleted → shallower + bias toward `recovering`/sleep. Floor: never shallower than today's fast-mode depth.
- *Integration:* `core/organism.ts`, `reasoning/pipeline.ts`, `reasoning/agentLoop.ts`, `core/workspace.ts`, `reasoning/adaptiveController.ts`.
- *Files:* new `core/energyBudget.ts`; edits to those + `config.ts` (`ENERGY_BUDGET`, OFF), gate.
- *Testing:* `energybudget:selfcheck` (monotonicity, charge/recover, depleted→shallow, flag-OFF parity) + runtime depletion/recovery.
- *Impact:* Genuine metabolic constraint + self-pacing; a principled global throttle. *Complexity:* M. *Risk:* Medium (mis-tuning → shallow; mitigated by flag-OFF + fast-mode floor).

**H2 · Developmental activation of dark features (infant → adult).**
- *Problem:* The richest capabilities ship static default-OFF; the brain never grows into them despite a 9-stage ladder.
- *Root cause:* each feature is a static env boolean; nothing ties activation to maturity/competence.
- *Proposed architecture:* `core/maturation.ts` resolving each cognitive feature's effective enablement as `staticFlag OR (stage ≥ S AND competence ≥ C AND energyAvailable)`, reusing `core/stages.ts` + `core/selfModel.ts` + H1. Static flags stay a hard override; maturation can only *enable*, and **never** touches `localOnly`/`allowShell`. Emits a `feature-activated` cognition event.
- *Integration:* the cognitive-flag read sites; `core/stages.ts`, `core/selfModel.ts`.
- *Files:* new `core/maturation.ts` + `shared/maturation.ts`; swap `CONFIG.x` → `isFeatureActive("x")` at cognitive read sites; `config.ts` (`MATURATION`, OFF); `GET /api/brain/maturation`; gate.
- *Testing:* `maturation:selfcheck` (truth table, session-monotonic, security flags never auto-enabled, flag-OFF parity) + runtime stage-gated activation.
- *Impact:* The literal "developmental brain (infant→adult)" — dark features become an earned, observable arc. *Complexity:* M. *Risk:* Medium (guarded by competence + energy + security exclusion + flag-OFF).

**H3 · Imagination → decision coupling.**
- *Problem:* `core/imagination.ts` simulates counterfactual futures but the output never reaches planning/action selection.
- *Root cause:* imagination runs async to the pipeline/agent loop; no consumer maps simulated outcomes to a choice.
- *Proposed architecture:* `reasoning/imaginativePlanning.ts` — roll the top-N candidate actions through imagination + `causalMap` (predicted outcome + confidence) and bias selection toward the best (blend-capped, like the existing 0.5 cap). Read-only sim; the chosen action still goes through `executeAction`; energy-gated via H1.
- *Integration:* `reasoning/agentLoop.ts`, `core/imagination.ts`, `core/causalMap.ts`, `core/organism.ts`.
- *Files:* new `reasoning/imaginativePlanning.ts`; edits to `agentLoop.ts`, `config.ts` (`IMAGINATIVE_PLANNING`, OFF), gate.
- *Testing:* `imaginativeplanning:selfcheck` (reorder by predicted outcome, blend cap, trust boundary intact, flag-OFF parity) + runtime imagined-best ≠ naive-first.
- *Impact:* Closes the imagination loop; counterfactual reasoning finally informs behavior. *Complexity:* M–H. *Risk:* Medium (sim cost; energy-gated + capped N + flag-OFF).

**H4 · Event-driven global workspace.**
- *Problem:* the workspace runs only on a 10-min timer; GWT predicts rapid salience-driven switching; high-salience events can't grab the conscious slot.
- *Root cause:* `workspace` is purely interval-scheduled in `brainCore`.
- *Proposed architecture:* extract `requestCycle(reason)` with debounce + refractory + rate limit + energy gate; subscribe high-salience bus events (large surprise, new open-question, contested belief, immune/safety event) in `brainCore` to request an off-cycle run; timer stays as tonic baseline.
- *Integration:* `core/workspace.ts`, `agents/brainCore.ts`, `core/neuromodulators.ts`, H1.
- *Files:* edits to those + `config.ts` (`WORKSPACE_EVENT_DRIVEN`, OFF), gate (extend `workspace:selfcheck`).
- *Testing:* debounce/refractory/rate/energy gates + flag-OFF parity; runtime synthetic high-surprise → off-cycle thought.
- *Impact:* Reactive consciousness. *Complexity:* M. *Risk:* Low–Medium (thrash → refractory + rate-limit + energy + flag-OFF).

### MEDIUM
- **M1 · Continuous gated lifelong-learning loop** — turn on-demand `core/evolutionOptimizer.ts` into a *scheduled* ratchet with held-out champion/challenger promotion + checkpointing + dopamine reward. *Risk:* Medium. *Complexity:* M.
- **M2 · Hybrid symbolic layer** — goal-conflict detection that finally *emits* the defined-but-never-populated `conflicting-goals` immune event + simple logical-consistency checks over beliefs/causal map. *Risk:* Low. *Complexity:* M.
- **M3 · Dynamic module registry** — self-registering subsystems (routes + kernel modules + selfchecks) to break the 30-router hard-wiring in `index.ts`. *Risk:* Medium. *Complexity:* M–H.
- **M4 · Bridge-or-quarantine the orphaned Rust brains** — a real Node↔Tauri/`computer-brain` IPC seam, or a formal dead-code quarantine + doc. *Risk:* Medium. *Complexity:* H (bridge) / L (quarantine).

### LOW
- **L1 · Neuromodulator tonic baseline effects** — mild tonic modulation at baseline (flagged), fixing the "baseline = no-op" inaccuracy. *Risk:* Medium. *Complexity:* S.
- **L2 · Continuous Hebbian decay tick** — light background decay vs. only-at-sleep. *Risk:* Low. *Complexity:* S.
- **L3 · Memory reconsolidation on retrieval** — retrieved traces strengthen + slightly perturb. *Risk:* Low. *Complexity:* S–M.
- **L4 · Targeted indexes** — composite `memory_relations(from_id,to_id)` + relation `LIMIT`s. *Risk:* Low. *Complexity:* S.

### FUTURE RESEARCH
- **F1 · Self-code-generation loop** — hypothesis → implementation → sandbox test → gated deploy, on the existing verify-until-correct coding loop. *Risk:* High. *Complexity:* XL.
- **F2 · Real distributed cognition** — turn on civilization with tested inter-brain memory/reputation sync; multi-machine. *Risk:* High. *Complexity:* XL.
- **F3 · Spatial reasoning + object permanence + embodied sensorimotor grounding** — genuinely missing. *Risk:* High. *Complexity:* XL.
- **F4 · Learned concept formation / deeper abstraction** — facts → principles → axioms (replace the regex classifier). *Risk:* Medium. *Complexity:* L.
- **F5 · Native/GPU vector substrate** — turbovec in-process napi / real ANN at >100k vectors. *Risk:* Medium. *Complexity:* L.

---

## Implementation status

Implemented as flag-gated slices (observability default-ON/additive; all others default-OFF), each with a hermetic selfcheck wired into `npm run gate`. Every change is failure-isolated on `/api/ask` and preserves the local-first invariants (LOCAL_ONLY/allowShell are never auto-relaxed — maturation explicitly excludes them).

| Item | Status | Selfcheck | Notes |
|------|--------|-----------|-------|
| C1 Observability spine | ✅ done, gate-green | `observability:selfcheck` (16) | metrics + `brain_vitals` + `diagnostics_log` + `/api/brain/{vitals,metrics,diagnostics}`; migration 0014 |
| C2 Substrate unblock | ✅ done, gate-green | `substrate:selfcheck` (16) | FTS5 keyword search (+LIKE fallback), bounded relations, bounded turbovec mirror |
| C3 Active inference | ✅ done, gate-green | `activeinference:selfcheck` (18) | surprise→epistemic foraging; warm-start floor; egress-safe; learns from realized surprise |
| H1 Energy budget | ✅ done, gate-green | `energybudget:selfcheck` (11) | energy gates depth/retrieval/foraging/rest; no-regression floor at half energy |
| H2 Developmental activation | ✅ done, gate-green | `maturation:selfcheck` (15) | `isFeatureActive` resolver (composes static+stage+energy); wired for creativity + evolution-loop; `/api/brain/maturation`; security flags provably excluded |
| H4 Event-driven workspace | ✅ done, gate-green | `eventworkspace:selfcheck` (6) | `requestWorkspaceCycle` with refractory + energy gate; brainCore subscribes immune/high-uncertainty events |
| H3 Imagination→decision | ✅ done, gate-green | `imaginativeplanning:selfcheck` (24) | Design option (a) — *advisory foresight*: `reasoning/imaginativePlanning.ts` reads the causal world model (imagination reflections + the embodiment layer's observed `action:<id>` outcomes) before the agent loop executes a tool; a high, well-observed failure rate (≥0.65 rate, ≥0.5 confidence ≈ 4 real observations) DEFERS the call one round with a FORESIGHT note so the model can revise its plan. Advisory, never a veto — an immediate repeat proceeds; every execution still goes through `executeAction`; one deferral per action per run; cold-ledger no-regression floor. `IMAGINATIVE_PLANNING` (OFF) or earned via maturation at stage 6. |

MEDIUM/LOW/FUTURE remain roadmap. The full `npm run gate` is green with all seven slices wired in.
