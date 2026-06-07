# Cognitive Loop Roadmap

STAR was handed a 15-pillar cognitive-OS spec ("perceive, understand, remember,
reason, learn, plan, improve continuously"). This document maps each pillar to
**what exists**, what the **central cognitive loop** slice (this PR) added, and
the **remaining deep work** as sequenced follow-on phases.

## What the cognitive-loop slice delivered

A unified, persistent **BrainState** the 7-step pipeline reads and writes, closing
the loop:

```
perceive(prompt) → attend(saliency map) → reason → error(confidence)
   → [confidence < floor? hold an "open-question" in working memory]
   → respond → learn → recordReasoning(confidence, citedCount)
        ↑                                              │
        └─ priorUncertainty() → shouldBroadenRetrieval ┘
           (low prior confidence forces multi-query expansion next cycle)
```

**What "feeds forward" concretely means.** `priorUncertainty()` (= `1 - last
confidence`, or 0 on a cold brain) drives `shouldBroadenRetrieval`: when the prior
cycle was uncertain (`≥ 0.6`), the next cycle FORCES multi-query expansion in the
memory step — broader recall, a real change to what's retrieved (visible as
`· ff:broaden`). The same scalar is also surfaced as saliency's `uncertainty`
term, but that is a UI/score signal only: a uniform additive shift across all
candidates cannot reorder the ranker's monotonic blend. The behavioral lever is
the broaden gate; the `open-question` working item is the observable trace.

- `shared/brainState.ts` — the contract (attention map, working memory, goal
  graph, confidence, learning metrics).
- `server/src/core/brainState.ts` — the singleton (mirrors `core/organism.ts`),
  persisted to the existing `organism_state` KV (no migration). Pure helpers
  (`decayWorking`, `capWorking`, `shouldReReason`, `extractWorkingItems`).
- Pipeline hooks (`reasoning/pipeline.ts`): `perceive` (input); behavioral
  feed-forward `shouldBroadenRetrieval(priorUncertainty)` → forces multi-query +
  `attend` (memory); `recordReasoning` (learning).
- The operating contract: `COGNITIVE_PRINCIPLES` injected into `reasoning/prompts.ts`.
- `GET /api/brain/state` + the live `BrainStatePanel` + `brain-state` bus event.
- Autonomous thought: `tickDecay` heartbeat in `agents/brainCore.ts` ages the workspace.
- Gate: hermetic `brainstate:selfcheck`; runtime: live `/api/ask` → `/api/brain/state`.

## Pillar status map

| # | Pillar | Status | Where |
|---|--------|--------|-------|
| 1 | Perception | Partial | `perception/` (audio/image→text). **Gap:** entity/concept/emotion extraction. |
| 2 | Working memory | **Done (server)** | `core/brainState.ts` workspace (was frontend-only). |
| 3 | Attention | Done | `attention/saliency.ts` → BrainState attention map. |
| 4 | Long-term memory | Done | `memory/` (importance, decay, consolidation, contradiction). |
| 5 | Reasoning | Partial | 7-step pipeline + ReAct loop (`agentLoop.ts`). **Gap:** multi-hypothesis. |
| 6 | Metacognition | **Done (deferred)** | confidence now ACTS — low-confidence flags an open question that raises next-cycle uncertainty. **Gap:** synchronous in-stream re-reason. |
| 7 | Goal management | Partial | `core/organism.ts` goals → BrainState goal graph. **Gap:** conflict arbitration, topo-sorted deps. |
| 8 | Learning | Done | ranker + RL bandit + Learning Lab; surfaced in BrainState metrics. |
| 9 | Self-reflection | Partial | `core/imagination.ts` reflect() (prediction-correction). **Gap:** general post-task "what did I learn". |
| 10 | Curiosity | Done | `core/curiosity.ts` (EIG) → idle exploration. |
| 11 | Prediction | Done | `twin/` + `core/causalMap.ts`. |
| 12 | Principles | **Done** | `COGNITIVE_PRINCIPLES` in `reasoning/prompts.ts`. |
| 13 | Brain state | **Done** | `core/brainState.ts` + `BrainStatePanel`. |
| 14 | Autonomous thought | Done | `agents/idleAgent.ts` + BrainState `tickDecay`. |
| 15 | Safety | Done | `actions/` allowlist + confirm-token + audit. **Gap:** reasoning-trace persistence. |

## Remaining phases (each its own PR + selfcheck + runtime check)

1. **Synchronous in-stream re-reason** (#6). The deferred flag is the safe default;
   a *live* low-confidence retry needs a per-run "revision" `PipelineEvent` shape +
   `PipelineOverlay` support so re-emitting a step doesn't corrupt the overlay
   (`PipelineOverlay.tsx:57-62` keys state by step id). Then plan-thread the
   re-reasoned plan before response streaming.
2. **Multi-hypothesis reasoning** (#5). Generate N candidate plans, score with a
   judge panel, synthesize — replacing the single-path reasoning step.
3. **Perception extraction** (#1). Entity/concept/emotion extraction in
   `perception/`, feeding typed working-memory items (not just transcripts).
4. **Goal-graph conflict arbitration** (#7). Topo-sort dependencies, detect cycles,
   arbitrate competing active goals by priority.
5. **General post-task reflection** (#9). After each cycle, a "what did I learn /
   what surprised me / what to improve" pass that writes durable lessons.
6. **Reasoning-trace persistence** (#15). Persist the reasoning/error step traces
   so the loop's decisions are fully auditable, not just the final answer.
7. **Per-conversation BrainState** (concurrency). The current singleton is
   last-writer-wins single-user; key BrainState by conversation for concurrent asks.
