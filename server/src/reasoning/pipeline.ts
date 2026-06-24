import type {
  LogicalRegionId,
  PipelineEvent,
  PipelineStatus,
  PipelineStepId,
} from "../../../shared/pipeline.js";
import type { MemoryPoint, ConversationMessage } from "../../../shared/memory.js";
import {
  getMemoryCount,
  getRelationCount,
  insertRelation,
  listRelationsAmong,
  upsertMemoryPoint,
  vectorSearch,
  type VectorSearchHit,
} from "../db/repositories/memory.js";
import {
  completePipelineRun,
  createPipelineRun,
  ensureConversation,
  failPipelineRun,
  insertMessage,
  listMessages,
} from "../db/repositories/conversations.js";
import {
  buildPromptContextBlock,
  buildRetrievalText,
  selectPriorTurns,
} from "./conversationContext.js";
import { getDefaultConnectorInstance, listConnectorInstances } from "../connectors/registry.js";
import { Connector, ConnectorError } from "../connectors/Connector.js";
import { CONFIG } from "../config.js";
import { broadcast } from "../ws/brainBus.js";
import {
  maybeExplore,
  rankHits,
  selectPromptHits,
  trainFromCitations,
} from "./ranker.js";
import { applyMemoryRetrievalBoost, onConversationMessage, processNewMemory } from "../memory/consolidationEngine.js";
import { updateMemoryImportance } from "../memory/memoryLifecycle.js";
import { getRegionPrototypes, routeQuery, DEPTH_DIFFICULTY_THRESHOLD, type RouteDecision } from "./router.js";
import { profileForRoute, modelForProfile } from "./modelRouting.js";
// Fable + Mythos upgrade (each flag-gated + failure-isolated; see config.ts).
import { shouldEscalate, salvageReason } from "./fastSalvage.js";
import { bestOfParallel } from "./parallelReasoning.js";
import {
  loadAdaptiveDepthState,
  saveAdaptiveDepthState,
  adjustThreshold,
  observeDepthOutcome,
} from "./adaptiveDepth.js";
import { getNarrative, narrativePreamble } from "../core/narrative.js";
import {
  decide as controllerDecide,
  reward as applyControllerReward,
  buildRetrievalContext,
  computeControllerOutcome,
} from "./adaptiveController.js";
import type { ControllerDecision, RetrievalContext } from "../../../shared/adaptive.js";
import { recordRankTrainingLog } from "../db/repositories/feedback.js";
import {
  COMBINED_REASONING_ERROR_SYSTEM,
  ERROR_SYSTEM,
  PROJECT_RERANK_SYSTEM,
  REASONING_SYSTEM,
  buildResponseSystem,
} from "./prompts.js";
import { createHash } from "node:crypto";
import { getCognitiveSwarm } from "../core/swarm.js";
import { getImaginationEngine } from "../core/imagination.js";
import { getPersistentOrganism } from "../core/organism.js";
import { getBrainState, shouldBroadenRetrieval } from "../core/brainState.js";
import { getBeliefEngine } from "../core/beliefs.js";
import { computeSaliency, type SaliencyContext } from "../attention/saliency.js";
import type { AttentionFocus } from "../../../shared/brainState.js";
import { hybridEnabled, shouldAugment, webResearch } from "../web/research.js";
import { expandQuery, reciprocalRankFusion } from "./queryExpansion.js";
import { validateMarkers } from "./citations.js";
import { applyReranker, trainReranker } from "./rerankerModel.js";
import { loadRerankerState, saveRerankerState } from "../db/repositories/adaptive.js";
import { DEFAULT_RETRIEVAL_K, RETRIEVAL_K_ARMS } from "../../../shared/adaptive.js";
import { surfaceError } from "../util/diagnostics.js";
import { logModelUsage, logRouting, getProfileSuggestions, updateRoutingProfile, type StepTimings } from "../db/repositories/modelUsage.js";
import { isLocalUrl } from "../util/network.js";
import { OpenAICompatibleConnector } from "../connectors/OpenAICompatibleConnector.js";
import { circuitRecordFailure, circuitRecordSuccess } from "../connectors/registry.js";
import { getSelfConsciousness } from "../core/selfConsciousness.js";
import { assessFaithfulness, appendFaithfulnessNote } from "./faithfulness.js";
import { formatSnippetForPrompt } from "./untrusted.js";
import {
  BASELINE,
  getNeuromodulators,
  shouldBroadenFromArousal,
  wantsFreshData,
} from "../core/neuromodulators.js";
import {
  getCognitiveDna,
  NEUTRAL_TRAITS,
  wantsBroaderRetrieval,
  responseTemperature,
  signalsFromCycle,
  type CognitiveTraits,
} from "../core/cognitiveDna.js";
import { getSelfRepresentation, selfPreamble } from "../core/selfRepresentation.js";
import { getUserModel, userPreamble } from "../core/userModel.js";
import { deriveDna, mergeDna, readDna, trustDemotion } from "../memory/memoryDna.js";
import { associativeNeighbors, recordCoCitations } from "../memory/hebbian.js";
import type { GraphContext } from "./ranker.js";
import {
  computeSurprise,
  loadPredictiveState,
  observeRetrieval,
  predictRetrieval,
  savePredictiveState,
  type RetrievalPrediction,
} from "./predictiveProcessing.js";
import {
  buildActiveInferenceContext,
  decideActiveInference,
  learnActiveInference,
  loadActiveInferenceState,
  saveActiveInferenceState,
} from "./activeInference.js";
import type { ActiveInferenceContext, ActiveInferencePolicy } from "../../../shared/activeInference.js";
import { currentEnergyBudget } from "../core/energyBudget.js";
import { isFeatureActive } from "../core/maturation.js";
import {
  calibrateConfidence,
  isWeakDomain,
  loadSelfModelState,
  observeCycle,
  saveSelfModelState,
} from "../core/selfModel.js";

// Phase 1 (blueprint) — assemble the per-query SaliencyContext from the
// organism singleton. Returns null if any of the cheap getters fails (the
// pipeline still works without saliency; the ranker just falls back to its
// pre-saliency blend). Wrapped in try/catch so the organism never becomes a
// hard dependency of /api/ask.
function buildSaliencyContext(query: string): SaliencyContext | null {
  try {
    const org = getPersistentOrganism();
    return {
      query,
      activeGoals: org.getActiveGoalTitles(8),
      organismHealth: org.getHealthScore(),
    };
  } catch (err) {
    surfaceError("pipeline.buildSaliencyContext", err);
    return null;
  }
}

// Build the BrainState attention map from the ranked hits. When a saliency
// context is present we recompute the full per-memory breakdown (cheap + pure)
// so the BrainStatePanel can show WHY each memory drew attention; otherwise we
// fall back to the raw retrieval score with a zeroed breakdown. Bounded to the
// top `limit` hits. Pure-ish (only computeSaliency); never throws into caller.
function buildAttentionFocuses(
  hits: VectorSearchHit[],
  ctx: SaliencyContext | null,
  limit = 8,
): AttentionFocus[] {
  const zero = { novelty: 0, goalRelevance: 0, emotion: 0, survival: 0, uncertainty: 0 };
  return hits.slice(0, limit).map((hit) => {
    const label = hit.memory.content.trim().slice(0, 80);
    if (!ctx) {
      return { id: hit.memory.id, label, score: Math.max(0, Math.min(1, hit.score)), breakdown: zero };
    }
    const b = computeSaliency(hit.memory, ctx);
    return {
      id: hit.memory.id,
      label,
      score: b.score,
      breakdown: {
        novelty: b.novelty,
        goalRelevance: b.goalRelevance,
        emotion: b.emotion,
        survival: b.survival,
        uncertainty: b.uncertainty,
      },
    };
  });
}

export interface AskRequest {
  prompt: string;
  conversationId?: string;
}

export type EmitFn = (event: PipelineEvent) => void;

const STEP_REGIONS: Record<PipelineStepId, LogicalRegionId[]> = {
  input: ["model-hub"],
  memory: ["memory-core", "file-memory"],
  reasoning: ["reasoning-cortex"],
  project: ["project-cortex"],
  error: ["error-detection-center"],
  response: ["response-center"],
  learning: ["learning-feedback-center"],
};

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function makeEvent(
  conversationId: string,
  runId: string,
  step: PipelineStepId,
  status: PipelineStatus,
  extra: Partial<PipelineEvent> = {},
): PipelineEvent {
  return {
    conversationId,
    runId,
    step,
    status,
    logicalRegions: STEP_REGIONS[step],
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function emitAll(event: PipelineEvent, emit: EmitFn): void {
  emit(event);
  broadcast({ type: "pipeline", ...event });
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Try to recover by extracting the first {...} block.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function snippetFor(memory: MemoryPoint): string {
  const trimmed = memory.content.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

// Vector-hit re-ranking now lives in ./ranker.ts (learned LTR + heuristic
// cold-start blend). The original recency/importance formula is preserved
// there as heuristicScore() so alpha=0 reproduces prior behaviour exactly.

function ensureSections(answer: string, knownMemoryIds: Set<string>): string {
  const headerRe = /\b(Known memory:|Inferred reasoning:|Uncertain:)/g;
  const headers = answer.match(headerRe) ?? [];
  if (headers.length === 3) {
    return validateMarkers(answer, knownMemoryIds);
  }
  // Rewrap a malformed answer.
  return [
    "Known memory:",
    "",
    "Inferred reasoning:",
    answer.trim(),
    "",
    "Uncertain:",
    "Model did not produce the required three sections; reasoning is shown above without verified citations.",
  ].join("\n");
}

async function chatJson<T>(
  connector: Connector,
  system: string,
  prompt: string,
  model?: string,
  temperature = 0.2,
): Promise<T | null> {
  const text = await connector.send(prompt, { system, format: "json", temperature, model });
  return safeJson<T>(text);
}

// FABLE F2 — difficulty at/above which a full route samples parallel drafts.
const PARALLEL_REASONING_DIFFICULTY_FLOOR = 0.8;

// Embeddings fallback chain. If the active chat connector cannot embed (e.g.
// GPT4All HTTP, or an OpenAI-compatible runtime configured without an
// embeddingModel), try any local Ollama instance the registry knows about.
// If neither path works, return null and the memory step will skip retrieval
// rather than fail the run.
function getEmbedder(active: Connector): Connector | null {
  if (active.embed) {
    return active;
  }
  const ollama = listConnectorInstances().find(
    (c) =>
      c.descriptor.kind === "ollama" &&
      c.descriptor.enabled &&
      c.descriptor.state === "ok" &&
      c.descriptor.isLocal &&
      Boolean(c.embed),
  );
  return ollama ?? null;
}

async function inferProjectName(
  connector: Connector,
  prompt: string,
  hits: VectorSearchHit[],
): Promise<string | null> {
  const candidates = Array.from(
    new Set(hits.map((h) => h.memory.projectName).filter((p): p is string => Boolean(p))),
  );
  if (candidates.length === 0) {
    return null;
  }
  try {
    const result = await chatJson<{ projectName: string | null }>(
      connector,
      PROJECT_RERANK_SYSTEM,
      `Question: ${prompt}\nCandidates: ${JSON.stringify(candidates)}`,
    );
    return result?.projectName ?? null;
  } catch {
    return null;
  }
}

export async function runPipeline(req: AskRequest, emit: EmitFn): Promise<void> {
  const connector = getDefaultConnectorInstance();
  const conversation = ensureConversation(req.conversationId, req.prompt);
  const run = createPipelineRun({ conversationId: conversation.id, prompt: req.prompt });
  const runId = run.id;
  const cid = conversation.id;

  if (!connector) {
    emitAll(makeEvent(cid, runId, "input", "error", { detail: "No default connector configured" }), emit);
    failPipelineRun(runId, "no connector");
    return;
  }

  // 1. INPUT
  emitAll(makeEvent(cid, runId, "input", "start", { detail: "Validating prompt" }), emit);
  if (req.prompt.trim().length === 0) {
    emitAll(makeEvent(cid, runId, "input", "error", { detail: "Empty prompt" }), emit);
    failPipelineRun(runId, "empty prompt");
    return;
  }
  insertMessage({ conversationId: cid, role: "user", content: req.prompt, pipelineRunId: runId });
  emitAll(makeEvent(cid, runId, "input", "complete"), emit);

  // Conversation continuity — assemble a compact transcript of the PRIOR turns
  // (excluding THIS run's just-inserted user message) so the otherwise-stateless
  // pipeline can resolve thin/anaphoric follow-ups ("tell me more", "why?").
  // Failure-isolated → empty context, never breaks the run.
  let priorTurns: ConversationMessage[] = [];
  try {
    priorTurns = selectPriorTurns(listMessages(cid), runId);
  } catch (err) {
    surfaceError("pipeline.conversationContext", err);
  }
  const conversationBlock = buildPromptContextBlock(priorTurns);

  // Step timing instrumentation
  const stepTimings: StepTimings = {};
  let stepStart: number;
  // COGNITIVE LOOP — perceive: the brain takes the prompt into its persistent
  // working memory. Failure-isolated inside the singleton, so this never breaks
  // the run even if the BrainState DB is unhappy.
  getBrainState().perceive(req.prompt, cid);
  // MoE router — pick the expert cortices + a depth gate for this query. The
  // lexical route is computed up front (deterministic, no deps); it gets an
  // optional embedding-refined upgrade once the query embedding exists (memory
  // step below). `route.depth === "shallow"` lets the reasoning step skip the
  // expensive LLM plan call entirely.
  // Fast mode ("be like Fable"): raise the depth gate so more queries take the
  // cheap embed→search→stream path and skip the two blocking LLM round-trips.
  let depthThreshold = CONFIG.fastMode ? CONFIG.fastModeDepthThreshold : undefined;
  // FABLE F3 — outcome-learned adaptive compute: nudge the threshold from past
  // citation outcomes. Warm-start floor returns the base EXACTLY until enough
  // observations accrue, so this is a strict no-op on a cold brain. OFF by
  // default; failure-isolated → falls back to the static threshold.
  if (CONFIG.adaptiveDepth) {
    try {
      const base = CONFIG.fastMode ? CONFIG.fastModeDepthThreshold : DEPTH_DIFFICULTY_THRESHOLD;
      depthThreshold = adjustThreshold(base, loadAdaptiveDepthState(), CONFIG.adaptiveDepthWarmAt);
    } catch (err) {
      surfaceError("pipeline.adaptiveDepth", err);
    }
  }
  // HOMEOSTATIC ENERGY (H1) — a tired brain thinks less hard: low energy nudges
  // the depth gate UP so more queries take the cheap embed→search→stream path.
  // Captured once for the whole run and reused below for retrieval breadth + the
  // active-inference energy deficit. No-regression: at/above FULL_FLOOR energy
  // depthPenalty is 0 (and the whole budget is a strict no-op when ENERGY_BUDGET
  // is off, or on any organism read fault).
  const energyBudget = currentEnergyBudget();
  if (energyBudget.depthPenalty > 0) {
    const base = depthThreshold ?? DEPTH_DIFFICULTY_THRESHOLD;
    depthThreshold = Math.min(1, base + energyBudget.depthPenalty);
  }
  let route: RouteDecision = routeQuery(req.prompt, { depthThreshold });
  const swarm = getCognitiveSwarm();
  // Per-request swarm/imagination rehearsal — OFF by default (experimental
  // subsystems stay behind routers, not in the pipeline hot path; CLAUDE.md).
  // Wrapped in try/catch FIRST: a throw here used to kill /api/ask outright.
  // (`swarm` is also used downstream at the full-route consensus call.)
  if (CONFIG.enablePerRequestSwarm) {
    try {
      swarm.routeCognitiveWorkflow(
        `Answer user request: ${req.prompt.slice(0, 180)}`,
        { conversationId: cid, runId, prompt: req.prompt },
        { includeExecution: false, priority: 68, privacyMode: "local-first" },
      );
    } catch (err) {
      surfaceError("pipeline.swarm", err);
    }
  }
  if (CONFIG.enablePerRequestImagination) {
    try {
      getImaginationEngine().imagine({
        goal: `Mentally rehearse answer path for: ${req.prompt.slice(0, 180)}`,
        action: req.prompt,
        mode: "future-prediction",
        branchCount: 3,
        context: { conversationId: cid, runId },
      });
    } catch (err) {
      surfaceError("pipeline.imagination", err);
    }
  }

  // 2. MEMORY
  stepStart = Date.now();
  emitAll(makeEvent(cid, runId, "memory", "start", { detail: "Embedding question + searching memory" }), emit);
  let memoryHits: VectorSearchHit[] = [];
  let memoryError: string | undefined;
  let rankFeatures: Map<string, number[]> = new Map();
  let rankWarm = false;
  let rankAlpha = 0;
  let saliencyApplied = false;
  let webAugmentNote = "";
  let multiQueryNote = "";
  let feedForwardNote = "";
  let hebbianNote = "";
  // Predictive processing: what the brain EXPECTED retrieval to do (set in the
  // memory step), compared against reality in the learning step.
  let prediction: RetrievalPrediction | null = null;
  let actualTopScore = 0;
  // RL adaptive controller state for this run (in-memory; decision in the memory
  // step → reward in the learning step). null whenever the controller is off.
  let controllerDecision: ControllerDecision | null = null;
  let controllerCtx: RetrievalContext | null = null;
  // ACTIVE INFERENCE (C3) state for this run — context + policy captured in the
  // memory step, the realised surprise folded back in the learning step. null
  // whenever active inference is off or its context build failed.
  let aiCtx: ActiveInferenceContext | null = null;
  let aiPolicy: ActiveInferencePolicy | null = null;
  // Active inference is gated once per request (maturation reads the persisted
  // stage from SQLite; computing it once avoids a redundant read at the learn site).
  const aiActive = isFeatureActive("active-inference");
  const webHitIds = new Set<string>(); // ids of FUSED WEB hits, for the augment reward
  const embedder = getEmbedder(connector);
  if (embedder?.embed) {
    const embedFn = embedder.embed.bind(embedder);
    try {
      // Thin/anaphoric prompts ("tell me more") embed WITH the recent transcript
      // prepended so the referent is in the vector query; self-contained prompts
      // embed verbatim (zero retrieval regression). See conversationContext.ts.
      const embedding = await embedFn(buildRetrievalText(req.prompt, priorTurns));
      // Embedding-refined route. Independent try/catch so a failure here
      // (prototype embed error, etc.) NEVER falls into the outer catch and
      // skips retrieval — we just keep the lexical route.
      try {
        const protos = await getRegionPrototypes({ embed: embedFn });
        route = routeQuery(req.prompt, { queryEmbedding: embedding, regionPrototypes: protos, depthThreshold });
      } catch {
        // keep lexical route
      }
      // Retrieve a baseline candidate set. When the adaptive controller is on we
      // pull the widest arm so the retrievalK slot can SLICE down to its choice
      // from a single fetch (no re-query); otherwise the historical default.
      const controllerOn = CONFIG.adaptiveController;
      let baseK = controllerOn ? Math.max(...RETRIEVAL_K_ARMS) : DEFAULT_RETRIEVAL_K;
      // Energy (H1): a tired brain retrieves a slightly narrower pool. Applied
      // only on the non-controller path (the controller manages its own k by
      // slicing down from the widest arm); strict no-op at full energy.
      if (!controllerOn && energyBudget.retrievalScale < 1) {
        baseK = Math.max(5, Math.round(baseK * energyBudget.retrievalScale));
      }
      let raw = await vectorSearch(embedding, baseK);

      // PREDICTIVE PROCESSING — record what the brain expected of LOCAL memory
      // here (top raw vec score, before augmentation), so the learning step can
      // compute the prediction error. Failure-isolated → no prediction.
      actualTopScore = raw[0]?.score ?? 0;
      if (CONFIG.predictiveProcessing) {
        try {
          prediction = predictRetrieval(loadPredictiveState(), req.prompt);
        } catch (err) {
          surfaceError("pipeline.predict", err);
        }
      }

      // COGNITIVE LOOP — BEHAVIORAL feed-forward: read last cycle's uncertainty
      // ONCE. When the prior cycle was uncertain we BROADEN retrieval this cycle
      // by forcing multi-query expansion (this genuinely changes WHAT is
      // retrieved). The same value also feeds saliency's uncertainty term below
      // (a UI/score signal). Failure-isolated → 0 (neutral) on any fault.
      let priorUncertainty = 0;
      try {
        priorUncertainty = getBrainState().priorUncertainty(cid);
      } catch (err) {
        surfaceError("pipeline.priorUncertainty", err);
      }
      const broadenForUncertainty = CONFIG.multiQueryRag && shouldBroadenRetrieval(priorUncertainty);
      if (broadenForUncertainty) feedForwardNote = ` · ff:broaden(${priorUncertainty.toFixed(2)})`;

      // NEUROMODULATION — read the global modulator levels once per run.
      // Failure-isolated: baseline levels make every consumer a strict no-op.
      let modulatorLevels = { ...BASELINE };
      try {
        modulatorLevels = getNeuromodulators().levels();
      } catch (err) {
        surfaceError("pipeline.neuromodLevels", err);
      }
      // Norepinephrine (arousal) broadens retrieval the same way a
      // low-confidence prior cycle does.
      const broadenForArousal = CONFIG.multiQueryRag && shouldBroadenFromArousal(modulatorLevels);
      if (broadenForArousal) feedForwardNote += " · ne:broaden";
      // SELF-MODEL — a measured-weak domain (by the top hit's project) also
      // broadens: the brain knows where it's blind and compensates.
      let weakDomainBroaden = false;
      try {
        weakDomainBroaden =
          CONFIG.multiQueryRag && isWeakDomain(loadSelfModelState(), raw[0]?.memory.projectName ?? null);
      } catch (err) {
        surfaceError("pipeline.selfModelWeak", err);
      }
      if (weakDomainBroaden) feedForwardNote += " · weak-domain:broaden";

      // COGNITIVE DNA — a memory-focused character leans harder on its own
      // memory, so it broadens recall to gather more. Strict no-op at the
      // neutral 0.5 trait (the high-water gate stays closed); failure-isolated.
      let dnaTraits: CognitiveTraits = NEUTRAL_TRAITS;
      try {
        dnaTraits = getCognitiveDna().traits();
      } catch (err) {
        surfaceError("pipeline.dnaTraits", err);
      }
      const broadenForMemoryFocus = CONFIG.multiQueryRag && wantsBroaderRetrieval(dnaTraits);
      if (broadenForMemoryFocus) feedForwardNote += " · dna:broaden";

      // ACTIVE INFERENCE (C3) — close the predictive loop: ACT to reduce
      // EXPECTED free energy. From the retrieval prediction + prior uncertainty +
      // arousal/ACh, decide whether to FORAGE for more evidence (broaden /
      // augment) BEFORE answering, so the brain reduces predicted surprise
      // instead of merely measuring it after the fact. Warm-start floor → zero
      // perturbation on a cold brain; the augment vote is still gated by hybridOn
      // below (egress-safe). The realised surprise trains the policy in the
      // learning step.
      let aiBroaden = false;
      let aiAugment = false;
      // Active inference (C3) — a loop-closer routed through maturation (H2): a
      // matured brain (stage ≥ 8) earns it even with the static flag off, while
      // its own warm-start floor keeps a cold brain identical to the heuristics.
      if (aiActive) {
        try {
          aiPolicy = loadActiveInferenceState();
          aiCtx = buildActiveInferenceContext({
            prediction,
            uncertainty: priorUncertainty,
            norepinephrine: modulatorLevels.norepinephrine,
            acetylcholine: (modulatorLevels as Record<string, number>).acetylcholine ?? 0.2,
            // H1: a depleted brain forages less (holding is metabolically cheaper).
            energyDeficit: energyBudget.energyDeficit,
          });
          const aiDecision = decideActiveInference(aiCtx, aiPolicy);
          aiBroaden = aiDecision.broaden;
          aiAugment = aiDecision.augment;
          if (aiDecision.acted) feedForwardNote += ` · ai:${aiDecision.action}(efe ${aiDecision.efe.toFixed(2)})`;
        } catch (err) {
          surfaceError("pipeline.activeInference", err);
        }
      }

      // The heuristic baselines (what the pipeline would do without the
      // controller). These are ALSO the warm-start the controller falls back to.
      // Acetylcholine (uncertainty tone) votes for fresh data over memory; the
      // vote only matters when the brain is already online (hybridOn carries
      // the LOCAL_ONLY egress gate — ACh can never bypass it). Active inference's
      // augment vote rides the SAME hybridOn gate; its broaden vote rides
      // CONFIG.multiQueryRag, exactly like the other broaden signals.
      const hybridOn = hybridEnabled();
      const heuristicAugment =
        hybridOn && (shouldAugment(req.prompt, raw).augment || wantsFreshData(modulatorLevels) || aiAugment);
      const heuristicMultiQuery =
        CONFIG.multiQueryRag &&
        raw.length > 0 &&
        (raw.length < 3 ||
          (raw[0]?.score ?? 0) < 0.45 ||
          broadenForUncertainty ||
          broadenForArousal ||
          weakDomainBroaden ||
          broadenForMemoryFocus ||
          aiBroaden);

      // RL CONTROLLER (opt-in). Decides augment / retrieval-k / multi-query /
      // model-profile from the bandit (warm-started at the heuristics, so a cold
      // brain behaves identically). Failure-isolated → heuristics on any error.
      let wantAugment = heuristicAugment;
      let wantMultiQuery = heuristicMultiQuery;
      if (controllerOn) {
        controllerCtx = buildRetrievalContext(req.prompt, raw, hybridOn);
        controllerDecision = controllerDecide(controllerCtx, {
          augment: heuristicAugment,
          retrievalK: DEFAULT_RETRIEVAL_K,
          multiQuery: heuristicMultiQuery,
          modelProfile: profileForRoute(route),
        });
        raw = raw.slice(0, controllerDecision.retrievalK);
        wantAugment = controllerDecision.augmentWeb;
        wantMultiQuery = controllerDecision.multiQuery;
      }

      // MULTI-QUERY RAG: rephrase the query a few ways, retrieve each, and
      // Reciprocal-Rank-Fuse the union for higher recall. Failure-isolated so it
      // can only ADD recall, never break retrieval.
      if (wantMultiQuery && raw.length > 0) {
        try {
          const variants = await expandQuery(
            req.prompt,
            (sys, user) => connector.send(user, { system: sys, temperature: 0.3 }),
            { variants: CONFIG.multiQueryVariants },
          );
          if (variants.length > 1) {
            // Embed + search each variant CONCURRENTLY (not in a serial await
            // loop) — RRF below is order-independent, so fusing the union is
            // identical, but the N-1 embed round-trips now overlap instead of
            // stacking. A single variant that fails to embed is dropped (its
            // list omitted), never breaking the fusion.
            const variantLists = await Promise.all(
              variants.slice(1).map((v) =>
                embedFn(v)
                  .then((vec) => vectorSearch(vec, baseK))
                  .catch((err) => {
                    surfaceError("pipeline.multiQuery.variant", err);
                    return [] as VectorSearchHit[];
                  }),
              ),
            );
            const lists: VectorSearchHit[][] = [raw, ...variantLists.filter((l) => l.length > 0)];
            raw = reciprocalRankFusion(lists, { limit: controllerDecision?.retrievalK ?? DEFAULT_RETRIEVAL_K });
            multiQueryNote = ` · mq:+${variants.length - 1}q`;
          }
        } catch (err) {
          surfaceError("pipeline.multiQuery", err);
        }
      }
      // HYBRID: local memory + live web, SIDE BY SIDE. The web is reached only
      // when the brain is explicitly online (hybridOn = LOCAL_ONLY=false +
      // HYBRID_RESEARCH + mode≠off) AND the decision (controller or heuristic)
      // says to augment — so the egress gate is never bypassed. webResearch reads
      // the top pages INTO memory (LEARNED, vector-retrievable next time) and
      // returns them as fusable, citeable hits. Self-contained try/catch so a web
      // failure NEVER costs the local answer already in hand.
      if (hybridOn && wantAugment) {
        try {
          const wr = await webResearch(req.prompt, { embed: embedFn, limit: CONFIG.webResearchMaxPages });
          if (wr.hits.length > 0) {
            for (const h of wr.hits) webHitIds.add(h.memory.id);
            raw = [...raw, ...wr.hits];
          }
          webAugmentNote = wr.ok
            ? ` · web:${wr.provider}(+${wr.ingested} learned, ${wr.hits.length} fused)`
            : ` · web:skipped(${wr.reason})`;
        } catch (err) {
          surfaceError("pipeline.hybrid", err);
        }
      } else if (hybridOn) {
        webAugmentNote = " · web:off(decision)";
      }
      // HEBBIAN ASSOCIATIVE RECALL — (a) well-worn association edges pull
      // missed neighbours into the candidate pool (bounded, score-anchored
      // below the weakest real hit), and (b) the candidate set's relation
      // graph feeds the ranker's existing PPR blend so activation spreads over
      // learned associations. Failure-isolated; an empty graph is a no-op.
      let graphCtx: GraphContext | undefined;
      if (CONFIG.hebbianRetrieval && raw.length > 0) {
        try {
          const neighbors = associativeNeighbors(raw);
          if (neighbors.length > 0) {
            raw = [...raw, ...neighbors];
            hebbianNote = ` · hebb:+${neighbors.length}`;
          }
          graphCtx = {
            relations: listRelationsAmong(raw.map((h) => h.memory.id)),
            totalRelations: getRelationCount(),
          };
        } catch (err) {
          surfaceError("pipeline.hebbian", err);
        }
      }
      // Assemble the saliency context cheaply. The organism singleton's
      // public getters are the seam; both calls are bounded (~80 row scan +
      // single SELECT). Wrap in try/catch so a misbehaving organism (e.g.
      // never woke / empty DB) can never break retrieval — saliency is a
      // refinement, not a critical-path dependency.
      const saliencyCtx = buildSaliencyContext(req.prompt);
      // Surface the same priorUncertainty as saliency's uncertainty term — a
      // UI/score signal (the behavioral feed-forward is the broaden gate above).
      if (saliencyCtx) {
        saliencyCtx.uncertainty = priorUncertainty;
      }
      const r = rankHits(raw, saliencyCtx ?? undefined, graphCtx);
      // Lexical query-aware rerank of the top-K (ML). NO-OP until it has trained
      // (returns r.ranked unchanged), so enabling it never regresses a cold brain.
      memoryHits = CONFIG.rerankerEnabled
        ? applyReranker(req.prompt, r.ranked, loadRerankerState())
        : r.ranked;
      rankFeatures = r.featuresById;
      rankWarm = r.warm;
      rankAlpha = r.alpha;
      saliencyApplied = saliencyCtx !== null;
      // COGNITIVE LOOP — attend: record the attention map (what the brain
      // focused on this retrieval) into the persistent BrainState. Built from
      // the FINAL reranked hits + the saliency breakdown. Failure-isolated.
      try {
        getBrainState().attend(buildAttentionFocuses(memoryHits, saliencyCtx), cid);
      } catch (err) {
        surfaceError("pipeline.attend", err);
      }
    } catch (err) {
      memoryError = err instanceof Error ? err.message : String(err);
    }
  } else {
    // No connector can embed -- retrieval is skipped. The pipeline continues
    // and the response step will run without citations.
    memoryError = "No embeddings-capable runtime available — memory retrieval skipped";
  }
  const citations = memoryHits.map((hit) => ({
    memoryId: hit.memory.id,
    filePath: hit.memory.filePath ?? undefined,
    score: hit.score,
  }));
  // FABLE F1 — shallow→full salvage. A shallow (fast) route that retrieved
  // nothing / weak memory is escalated to the full path so the answer is
  // deepened (reasoning + error check) instead of answered thin — the cascade
  // "escalate on weak signal" pattern. Flag-gated and inert when retrieval is
  // strong (no-regression on the common fast case). connector is guaranteed
  // non-null here (the run early-returns above when it isn't), so the deeper
  // path can actually run. Uses actualTopScore (raw vec top) as the honest
  // "did we find anything relevant" signal.
  let salvageNote = "";
  if (CONFIG.fastSalvage) {
    const salvageInput = {
      depth: route.depth,
      hitCount: memoryHits.length,
      topScore: actualTopScore,
      fastMode: CONFIG.fastMode,
    };
    if (shouldEscalate(salvageInput, CONFIG.fastSalvageScoreFloor)) {
      salvageNote = ` · escalated:${salvageReason(salvageInput, CONFIG.fastSalvageScoreFloor)}`;
      route = { ...route, depth: "full" };
    }
  }
  const controllerNote = controllerDecision
    ? ` · rl(k=${controllerDecision.retrievalK},${Object.values(controllerDecision.source).includes("policy") ? "policy" : "warmup"})`
    : "";
  const rankerTag = ` · ranker α=${rankAlpha.toFixed(2)}${rankWarm ? " (warm)" : ""}${saliencyApplied ? " · saliency" : ""}${feedForwardNote}${multiQueryNote}${hebbianNote}${webAugmentNote}${controllerNote}${salvageNote}`;
  const memoryDetail = memoryError
    ? memoryError
    : embedder && embedder !== connector
      ? `${memoryHits.length} memories retrieved (embeddings via ${embedder.descriptor.id})${rankerTag}`
      : `${memoryHits.length} memories retrieved${rankerTag}`;
  emitAll(
    makeEvent(cid, runId, "memory", "complete", {
      detail: memoryDetail,
      citations,
    }),
    emit,
  );
  if (memoryHits.length > 0) {
    applyMemoryRetrievalBoost(memoryHits.map((h) => h.memory.id));
  }
  stepTimings.memory_ms = Date.now() - stepStart;

  // Per-cortex model routing (MoE). The controller's chosen profile when on, else
  // the heuristic route profile. A profile with no assigned model resolves to the
  // connector default (undefined), so a setup without per-profile mappings is a
  // no-op — wiring this finally makes the Model Hub assignments take effect.
  const chosenProfile = controllerDecision?.modelProfile ?? profileForRoute(route);
  const routedModelName = modelForProfile(chosenProfile) ?? undefined;

  // MYTHOS M3 — narrative-grounded reasoning. Prepend a compact first-person
  // identity preamble to the reasoning + response system prompts so the answer
  // stays consistent with who the brain is. Two sources, both riding this flag:
  //   - the M1 self-narrative ("how I've grown")
  //   - the UNIFIED self-representation ("who I am / what I'm doing / how I feel")
  //     which carries the cognitive-DNA character + the live dominant emotion —
  //     the channel through which the soft traits (logic, sociality) and emotion
  //     reach the answer's voice.
  // OFF by default (CONFIG.narrativeGrounding); failure-isolated. BOTH preambles
  // are empty until the brain has actually developed (neutral character + no
  // goals + no narrative), so a FRESH brain's prompts are byte-for-byte
  // unchanged. As the brain develops a character/goals, its voice begins to
  // appear here — which is the intended effect, not a regression.
  let narrativeGroundingBlock = "";
  if (CONFIG.narrativeGrounding || CONFIG.theoryOfMind) {
    try {
      const sections: string[] = [];
      // M3 — the brain's own identity voice (narrative + unified self).
      if (CONFIG.narrativeGrounding) {
        const lines: string[] = [];
        const narrativePre = narrativePreamble(getNarrative());
        if (narrativePre) lines.push(narrativePre);
        const { self, parts } = getSelfRepresentation();
        const selfPre = selfPreamble(self, parts);
        if (selfPre) lines.push(selfPre);
        if (lines.length > 0) {
          sections.push(
            `Your identity (keep your answer consistent with who you are; this is your voice, NOT factual memory to cite):\n${lines.join(" ")}`,
          );
        }
      }
      // Theory of Mind — who the brain is talking to. Empty (no section) until
      // the user model has formed over a few turns, so a cold brain is unchanged.
      if (CONFIG.theoryOfMind) {
        const userPre = userPreamble(getUserModel().model());
        if (userPre) {
          sections.push(
            `Who you're assisting (adapt depth and register to them; this is context, NOT factual memory to cite):\n${userPre}`,
          );
        }
      }
      if (sections.length > 0) narrativeGroundingBlock = sections.join("\n\n");
    } catch (err) {
      surfaceError("pipeline.narrativeGrounding", err);
    }
  }

  // 3. REASONING
  // Flash the routed expert cortices (deduped with reasoning-cortex) instead of
  // the static reasoning region, so the scene shows where this query was routed.
  const routedRegions: LogicalRegionId[] = [...new Set<LogicalRegionId>([...route.experts, "reasoning-cortex"])];
  const routeSummary = `experts ${route.experts.join(", ")} · difficulty ${route.difficulty.toFixed(2)} · ${route.depth}`;
  stepStart = Date.now();
  emitAll(makeEvent(cid, runId, "reasoning", "start", { logicalRegions: routedRegions }), emit);
  // What the LLM actually reads: warm-gated high-confidence subset, with the
  // position-bias shuffle applied. Smaller block → less context → faster
  // local inference. The full ranked set is still kept for training + the UI.
  // Kept OUTSIDE the depth branch — the error and response steps consume
  // memoryList even when reasoning is shallow.
  // MEMORY DNA — gently down-rank low-trust memories (raw web text) before
  // selecting what the LLM reads, so the answer leans on credible memory. Same
  // multiplicative re-score pattern as the project rerank below; strict no-op
  // when CONFIG.memoryDna is off OR a memory's trust is normal/high (factor 1.0).
  if (CONFIG.memoryDna) {
    memoryHits = memoryHits.map((hit) => {
      const factor = trustDemotion(readDna(hit.memory));
      return factor === 1 ? hit : { ...hit, score: hit.score * factor };
    });
  }
  const promptHits = maybeExplore(
    selectPromptHits(memoryHits, rankFeatures, rankWarm),
    runId,
    rankWarm,
  );
  // Injection hardening: external-provenance memories (ingest:web / ingest:github)
  // are fenced as untrusted quoted data so internet text can't smuggle
  // instructions into the reasoning/error/response prompts.
  const memoryList = promptHits
    .map((hit) => formatSnippetForPrompt(hit.memory, snippetFor(hit.memory)))
    .join("\n\n");
  // LATENCY — overlap the project-name inference with the reasoning + error LLM
  // calls. inferProjectName depends only on the prompt + retrieved hits (NOT the
  // reasoning plan), and its result isn't read until the learning step, so
  // kicking it off here lets it run concurrently instead of adding a serial
  // round-trip before the response streams. Shallow routes skip it entirely
  // (adaptive compute, like the reasoning step). Failure-isolated → null.
  const projectPromise: Promise<string | null> =
    route.depth === "full" && memoryHits.length > 0
      ? inferProjectName(connector, req.prompt, memoryHits).catch(() => null)
      : Promise.resolve(null);
  type ReasoningOut = { plan: string; openQuestions: string[] };
  type ErrorOut = { contradictions: string[]; missing: string[]; confidence: number };
  let reasoning: ReasoningOut = { plan: "", openQuestions: [] };
  let reasoningDetail: string;
  // When the combined reasoning+error pass (CONFIG.combinedReasoningError) runs,
  // it captures the error half here so the error step reuses it instead of paying
  // a second LLM round-trip. Stays null when the flag is off OR the merged JSON
  // omitted the error fields — in which case the error step falls back normally.
  let combinedErrorReport: ErrorOut | null = null;
  if (route.depth === "shallow") {
    // Adaptive compute: an easy query skips the expensive LLM reasoning plan
    // (and the swarm consensus) and answers directly from retrieved memory.
    reasoning = {
      plan: `Shallow route (difficulty ${route.difficulty.toFixed(2)}, experts ${route.experts.join(", ")}): answering directly from retrieved memory.`,
      openQuestions: [],
    };
    reasoningDetail = `Skipped LLM reasoning — ${routeSummary}`;
  } else {
    const reasoningUser = [
      conversationBlock,
      `Question:\n${req.prompt}`,
      `Memory snippets:\n${memoryList || "(empty)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const reasoningSystem = narrativeGroundingBlock
      ? `${narrativeGroundingBlock}\n\n${REASONING_SYSTEM}`
      : REASONING_SYSTEM;
    let parallelNote = "";
    try {
      let parsed: ReasoningOut | null = null;
      // LATENCY — combined reasoning + error in ONE call (opt-in). The error
      // step is otherwise a SECOND serial round-trip that blocks the first
      // streamed token; merging it here cuts that round-trip. This is an
      // alternative reasoning strategy, so it supersedes the parallel-drafts
      // path. The error half is captured into combinedErrorReport for the error
      // step; if the model omits those fields, combinedErrorReport stays null and
      // the error step falls back to its own call — so this never regresses.
      if (CONFIG.combinedReasoningError) {
        type CombinedOut = ReasoningOut & Partial<ErrorOut>;
        const combinedSystem = narrativeGroundingBlock
          ? `${narrativeGroundingBlock}\n\n${COMBINED_REASONING_ERROR_SYSTEM}`
          : COMBINED_REASONING_ERROR_SYSTEM;
        const c = await chatJson<CombinedOut>(connector, combinedSystem, reasoningUser, routedModelName);
        if (c) {
          parsed = {
            plan: c.plan ?? "",
            openQuestions: Array.isArray(c.openQuestions) ? c.openQuestions : [],
          };
          if (typeof c.confidence === "number" || Array.isArray(c.contradictions) || Array.isArray(c.missing)) {
            combinedErrorReport = {
              contradictions: Array.isArray(c.contradictions) ? c.contradictions : [],
              missing: Array.isArray(c.missing) ? c.missing : [],
              confidence: typeof c.confidence === "number" ? c.confidence : memoryHits.length > 0 ? 0.6 : 0.2,
            };
          }
        }
        if (!parsed) {
          // Merged call failed to parse → fall back to a plain reasoning call so
          // the route still produces a plan (the error step then runs normally).
          parsed = await chatJson<ReasoningOut>(connector, reasoningSystem, reasoningUser, routedModelName);
        }
        parallelNote = combinedErrorReport ? " · combined+err" : " · combined";
      } else if (CONFIG.parallelReasoning && route.difficulty >= PARALLEL_REASONING_DIFFICULTY_FLOOR) {
        // FABLE F2 — on a genuinely hard route, sample N reasoning drafts in
        // parallel and keep the most consistent (local lexical consensus, no
        // judge, no logprobs). bestOfParallel never throws; a draft whose JSON
        // is unparseable is treated as a failure, and if EVERY draft failed we
        // fall back to a single call (so this can never regress the route).
        const res = await bestOfParallel<ReasoningOut>(
          CONFIG.parallelReasoningDrafts,
          (i) =>
            chatJson<ReasoningOut>(connector, reasoningSystem, reasoningUser, routedModelName, 0.2 + i * 0.3).then(
              (r) => {
                if (!r) throw new Error("unparseable reasoning draft");
                return r;
              },
            ),
          (d) => d.plan ?? "",
        );
        parsed = res.best;
        if (res.ran > 1) parallelNote = ` · parallel(${res.ran} drafts, agree ${res.agreement.toFixed(2)})`;
        if (!parsed) {
          parsed = await chatJson<ReasoningOut>(connector, reasoningSystem, reasoningUser, routedModelName);
        }
      } else {
        parsed = await chatJson<ReasoningOut>(connector, reasoningSystem, reasoningUser, routedModelName);
      }
      if (parsed) {
        reasoning = {
          plan: parsed.plan ?? "",
          openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
        };
      }
    } catch (err) {
      emitAll(
        makeEvent(cid, runId, "reasoning", "error", {
          detail: err instanceof Error ? err.message : String(err),
        }),
        emit,
      );
      failPipelineRun(runId, "reasoning failed");
      return;
    }
    reasoningDetail = reasoning.plan.slice(0, 200) + parallelNote;
  }
  emitAll(
    makeEvent(cid, runId, "reasoning", "complete", {
      detail: reasoningDetail,
      logicalRegions: routedRegions,
    }),
    emit,
  );
  stepTimings.reasoning_ms = Date.now() - stepStart;
  if (route.depth === "full") {
    swarm.runConsensus(`Compare reasoning plans for: ${req.prompt.slice(0, 180)}`);
  }

  // 4. PROJECT
  emitAll(makeEvent(cid, runId, "project", "start"), emit);
  // Await the inference kicked off before the reasoning step (full routes only),
  // so the round-trip overlapped the reasoning call rather than blocking here.
  const projectName: string | null = await projectPromise;
  if (projectName) {
    memoryHits = memoryHits
      .map((hit) => ({
        ...hit,
        score: hit.score * (hit.memory.projectName === projectName ? 1.4 : 0.8),
      }))
      .sort((a, b) => b.score - a.score);
  }
  emitAll(
    makeEvent(cid, runId, "project", "complete", {
      detail:
        route.depth !== "full"
          ? "Skipped project re-rank — shallow route"
          : projectName
            ? `Re-ranked by project ${projectName}`
            : "No project re-rank",
    }),
    emit,
  );

  // 5. ERROR
  stepStart = Date.now();
  emitAll(makeEvent(cid, runId, "error", "start"), emit);
  let errorReport: ErrorOut = { contradictions: [], missing: [], confidence: memoryHits.length > 0 ? 0.6 : 0.2 };
  let errorReused = false;
  // Adaptive compute: the error step (contradiction/missing-data detection) is an
  // advisory LLM round-trip. On a shallow route (easy lookup query) we skip it —
  // exactly like the reasoning step — and keep the sensible defaults, so an easy
  // question goes embed → search → response with no extra round-trips. Hard
  // (full) queries still get the full check.
  if (route.depth === "full") {
    if (combinedErrorReport) {
      // The combined reasoning+error pass already produced this — reuse it
      // instead of paying a second round-trip. This is the latency win.
      errorReport = combinedErrorReport;
      errorReused = true;
    } else {
      try {
        const parsed = await chatJson<ErrorOut>(
          connector,
          ERROR_SYSTEM,
          `Question:\n${req.prompt}\n\nReasoning:\n${reasoning.plan}\n\nMemory:\n${memoryList || "(empty)"}`,
        );
        if (parsed) {
          errorReport = {
            contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
            missing: Array.isArray(parsed.missing) ? parsed.missing : [],
            confidence: typeof parsed.confidence === "number" ? parsed.confidence : errorReport.confidence,
          };
        }
      } catch (err) {
        // Soft-fail: the error step is advisory, so we keep the default
        // errorReport and let the pipeline continue — but surface it so a broken
        // connector or malformed JSON doesn't masquerade as "no issues found".
        surfaceError("pipeline.errorStep", err);
      }
    }
  }
  emitAll(
    makeEvent(cid, runId, "error", "complete", {
      detail:
        route.depth !== "full"
          ? `confidence ${errorReport.confidence.toFixed(2)} (skipped check — shallow route)`
          : `confidence ${errorReport.confidence.toFixed(2)}, ${errorReport.contradictions.length} contradictions${errorReused ? " (combined)" : ""}`,
    }),
    emit,
  );
  stepTimings.error_ms = Date.now() - stepStart;

  // 6. RESPONSE
  emitAll(makeEvent(cid, runId, "response", "start"), emit);
  const knownIds = new Set(promptHits.map((hit) => hit.memory.id));
  const baseResponseSystem = buildResponseSystem(memoryHits.length > 0);
  // MYTHOS M3 — same identity preamble grounds the final answer's voice.
  const responseSystem = narrativeGroundingBlock
    ? `${narrativeGroundingBlock}\n\n${baseResponseSystem}`
    : baseResponseSystem;
  const responsePrompt = [
    conversationBlock,
    `User question:\n${req.prompt}`,
    `Memory snippets you may cite as [m:<id>] (do not invent new ids):`,
    memoryList || "(empty)",
    `Reasoning plan:\n${reasoning.plan}`,
    errorReport.contradictions.length > 0
      ? `Known contradictions:\n${errorReport.contradictions.join("\n")}`
      : "",
    errorReport.missing.length > 0
      ? `Missing data:\n${errorReport.missing.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Telemetry + fallback: track which model served and whether we fell back.
  stepStart = Date.now();
  let assembled = "";
  let telemetryFallback = false;
  let telemetryError: string | null = null;
  const isRemote = !isLocalUrl(connector.descriptor.baseUrl ?? "");
  const telemetryKeyIndex =
    isRemote && connector instanceof OpenAICompatibleConnector
      ? connector.currentKeyIndex
      : null;

  // COGNITIVE DNA — a creative character answers with a higher temperature, a
  // literal one stays tight. responseTemperature() returns the existing 0.3 at
  // the neutral creativity trait, so a fresh brain's answers are byte-identical.
  // Failure-isolated.
  let responseTemp = 0.3;
  try {
    responseTemp = responseTemperature(getCognitiveDna().traits());
  } catch (err) {
    surfaceError("pipeline.responseTemp", err);
  }

  try {
    // Retry loop for remote providers: retry with exponential backoff before fallback.
    const maxAttempts = isRemote ? CONFIG.remoteRetryAttempts + 1 : 1;
    let lastError: unknown = null;
    let retryCount = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        assembled = "";
        for await (const token of connector.stream(responsePrompt, {
          system: responseSystem,
          temperature: responseTemp,
          model: routedModelName,
          // Fast mode: cap the answer so it stays tight instead of rambling to
          // the context limit (honored by both connectors as num_predict /
          // max_tokens). Request options always win, so a caller can override.
          maxTokens: CONFIG.fastMode ? CONFIG.fastModeMaxTokens : undefined,
        })) {
          assembled += token;
          emitAll(makeEvent(cid, runId, "response", "progress", { tokensDelta: token }), emit);
        }
        // Capture token usage from OpenAI-compatible streaming responses.
        if (connector instanceof OpenAICompatibleConnector && connector.lastUsage) {
          stepTimings.prompt_tokens = connector.lastUsage.promptTokens;
          stepTimings.completion_tokens = connector.lastUsage.completionTokens;
          connector.lastUsage = null;
        }
        circuitRecordSuccess(connector.descriptor.id);
        lastError = null;
        break; // success
      } catch (err) {
        lastError = err;
        retryCount = attempt + 1;
        if (attempt < maxAttempts - 1) {
          // Exponential backoff: 1s, 2s, 4s, ...
          const delay = 1000 * 2 ** attempt;
          emitAll(makeEvent(cid, runId, "response", "progress", {
            tokensDelta: `[retry ${attempt + 1}/${CONFIG.remoteRetryAttempts} in ${delay}ms] `,
          }), emit);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    if (retryCount > 0) stepTimings.retry_count = retryCount;
    if (lastError) {
      circuitRecordFailure(connector.descriptor.id);
      throw lastError;
    }
  } catch (err) {
    const message =
      err instanceof ConnectorError ? err.message : err instanceof Error ? err.message : String(err);

    // REMOTE FALLBACK: if the remote provider failed and fallback is enabled,
    // retry with the local Ollama connector. The response includes a degraded
    // tag so the user knows they got a weaker answer.
    if (isRemote && CONFIG.remoteFallback) {
      try {
        const localConnector = getDefaultConnectorInstance();
        if (localConnector) {
          assembled = "";
          telemetryFallback = true;
          emitAll(makeEvent(cid, runId, "response", "progress", { tokensDelta: "[fallback → local] " }), emit);
          for await (const token of localConnector.stream(responsePrompt, {
            system: responseSystem,
            temperature: responseTemp,
            maxTokens: CONFIG.fastMode ? CONFIG.fastModeMaxTokens : undefined,
          })) {
            assembled += token;
            emitAll(makeEvent(cid, runId, "response", "progress", { tokensDelta: token }), emit);
          }
        }
      } catch (fallbackErr) {
        telemetryError = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        emitAll(makeEvent(cid, runId, "response", "error", { detail: telemetryError }), emit);
        failPipelineRun(runId, telemetryError);
        // Log the original remote error, not the fallback error
        logModelUsage({
          runId,
          connectorId: connector.descriptor.id,
          provider: "remote",
          model: routedModelName ?? connector.descriptor.model ?? "unknown",
          keyIndex: telemetryKeyIndex,
          fallback: true,
          latencyMs: Date.now() - stepStart,
          stepTimings,
          error: message,
        });
        return;
      }
    } else {
      emitAll(makeEvent(cid, runId, "response", "error", { detail: message }), emit);
      failPipelineRun(runId, message);
      logModelUsage({
        runId,
        connectorId: connector.descriptor.id,
        provider: isRemote ? "remote" : "local",
        model: routedModelName ?? connector.descriptor.model ?? "unknown",
        keyIndex: telemetryKeyIndex,
        fallback: false,
        latencyMs: Date.now() - stepStart,
        stepTimings,
        error: message,
      });
      return;
    }
  }

  const responseLatencyMs = Date.now() - stepStart;
  stepTimings.response_ms = responseLatencyMs;
  let finalAnswer = ensureSections(assembled.trim(), knownIds);
  // Implicit relevance feedback: which *shown* memories the model actually cited
  // (validated [m:<id>] markers). Computed here (before the response-complete
  // emit) so the faithfulness note lands in the answer the client sees.
  const citedIds = new Set(
    Array.from(finalAnswer.matchAll(/\[m:([A-Za-z0-9]+)\]/g))
      .map((m) => m[1])
      .filter((id) => knownIds.has(id)),
  );
  // CITATION FAITHFULNESS (flag-gated, failure-isolated): does each cited memory
  // actually SUPPORT its claim? Unfaithful citations get a note in Uncertain AND
  // are dropped from `faithfulCitedIds` so the ranker/reranker stop rewarding
  // citation PRESENCE alone. A fault here must never cost the answer.
  let faithfulCitedIds = citedIds;
  if (CONFIG.citationFaithfulness && citedIds.size > 0) {
    try {
      const memoryTextById = new Map(memoryHits.map((h) => [h.memory.id, h.memory.content] as const));
      const fa = assessFaithfulness(finalAnswer, memoryTextById);
      if (fa.unfaithful.length > 0) {
        faithfulCitedIds = new Set(Array.from(citedIds).filter((id) => !fa.unfaithfulIds.has(id)));
        finalAnswer = appendFaithfulnessNote(finalAnswer, fa);
      }
    } catch (err) {
      surfaceError("pipeline.faithfulness", err);
    }
  }
  // Inject degraded tag when remote fallback was triggered
  if (telemetryFallback) {
    const degradedTag = "[degraded: remote fallback to local]";
    if (finalAnswer.includes("Uncertain:")) {
      finalAnswer = finalAnswer.replace("Uncertain:", `Uncertain:\n${degradedTag}`);
    } else {
      finalAnswer = `${finalAnswer}\n\nUncertain:\n${degradedTag}`;
    }
  }
  emitAll(
    makeEvent(cid, runId, "response", "complete", { detail: `${finalAnswer.length} chars` }),
    emit,
  );

  // Log telemetry for this response. Failure-isolated: this runs AFTER the
  // answer streamed but BEFORE the learning step, so a telemetry-write fault
  // must never break a successful run or skip memory persistence. (Matches the
  // hot-path contract used by the faithfulness/conversationContext hooks above.)
  if (CONFIG.promptVariant) stepTimings.prompt_variant = CONFIG.promptVariant;
  try {
    logModelUsage({
      runId,
      connectorId: connector.descriptor.id,
      provider: isRemote ? "remote" : "local",
      model: routedModelName ?? connector.descriptor.model ?? "unknown",
      keyIndex: telemetryKeyIndex,
      fallback: telemetryFallback,
      latencyMs: responseLatencyMs,
      stepTimings,
      error: telemetryError,
    });

    // Log routing decision for feedback loop
    logRouting({
      runId,
      profile: chosenProfile,
      model: routedModelName ?? connector.descriptor.model ?? "unknown",
      experts: JSON.stringify(route.experts),
      difficulty: route.difficulty,
      depth: route.depth,
      citedCount: promptHits.length,
      retrievedCount: memoryHits.length,
      confidence: errorReport.confidence,
      latencyMs: responseLatencyMs,
    });
  } catch (err) {
    surfaceError("pipeline.telemetry", err);
  }

  // Auto-optimize: if enabled, check if a better model is statistically proven for this profile.
  if (CONFIG.routingAutoOptimize) {
    try {
      const suggestions = getProfileSuggestions();
      for (const s of suggestions) {
        if (s.suggestedModel && s.suggestedModel !== s.currentModel && s.currentRuns >= 10 && s.qualityDelta > 0.20) {
          updateRoutingProfile(s.profile, s.suggestedModel);
        }
      }
    } catch { /* non-critical */ }
  }

  // 7. LEARNING
  emitAll(makeEvent(cid, runId, "learning", "start"), emit);
  insertMessage({
    conversationId: cid,
    role: "assistant",
    content: finalAnswer,
    pipelineRunId: runId,
  });
  // citedIds (+ the faithfulness-filtered faithfulCitedIds) were computed before
  // the response-complete emit so the faithfulness note could land in the
  // streamed answer. They are reused below for the citation graph + training.
  // COGNITIVE LOOP — close the cycle: persist this run's confidence + cited
  // count into BrainState. When confidence is below the floor the loop pushes an
  // "open-question" working item (DEFERRED metacognition) — it surfaces as a
  // raised priorUncertainty on the NEXT cycle rather than re-running steps in
  // this SSE stream. Single failure-isolated last-writer-wins upsert.
  // SELF-MODEL — correct the stated confidence with the MEASURED calibration
  // curve before it feeds the loop (cold bins pass it through unchanged, so
  // this is a strict no-op until 👍/👎 evidence accrues), and fold this cycle
  // into the per-domain competence map. Failure-isolated.
  let calibratedConfidence = errorReport.confidence;
  try {
    const selfState = loadSelfModelState();
    calibratedConfidence = calibrateConfidence(selfState, errorReport.confidence);
    saveSelfModelState(
      observeCycle(selfState, {
        projectName,
        confidence: errorReport.confidence,
        cited: citedIds.size > 0,
      }),
    );
  } catch (err) {
    surfaceError("pipeline.selfModel", err);
  }
  getBrainState().recordReasoning(
    {
      prompt: req.prompt,
      confidence: calibratedConfidence,
      citedCount: citedIds.size,
    },
    cid,
  );
  // NEUROMODULATION — one completed cycle pulses the global modulators:
  // citations → dopamine (reward), contradictions → norepinephrine (arousal),
  // an ungrounded/uncertain answer → acetylcholine (fresh-data hunger).
  try {
    getNeuromodulators().onCycle({
      confidence: errorReport.confidence,
      citedCount: citedIds.size,
      contradictions: errorReport.contradictions.length,
    });
  } catch (err) {
    surfaceError("pipeline.neuromodCycle", err);
  }
  // COGNITIVE DNA — the slow personality EMAs toward what this cycle showed:
  // grounded high-confidence deduction nurtures logic, using/ignoring memory
  // moves memoryFocus, confident-but-ungrounded answers feed creativity, and
  // surfaced gaps feed curiosity. One cycle barely moves the character (4% EMA);
  // a lifetime of consistent cycles shapes it. Failure-isolated.
  try {
    getCognitiveDna().evolve(
      signalsFromCycle({
        confidence: calibratedConfidence,
        citedCount: citedIds.size,
        openQuestionCount: errorReport.missing.length,
      }),
    );
  } catch (err) {
    surfaceError("pipeline.dnaEvolve", err);
  }
  // THEORY OF MIND — fold this turn into the model of the PERSON (recurring
  // interests, sustained domains, preferred style, stated goals). Passive: it
  // updates whether or not the preamble is injected (the inject is separately
  // gated by CONFIG.theoryOfMind), so the model is always warming. Failure-isolated.
  try {
    getUserModel().observe({
      prompt: req.prompt,
      answer: finalAnswer,
      citedCount: citedIds.size,
      confidence: calibratedConfidence,
    });
  } catch (err) {
    surfaceError("pipeline.userModel", err);
  }
  // PREDICTIVE PROCESSING — compare expectation against reality. Surprise
  // pulses norepinephrine; "expected to KNOW this and didn't" holds an open
  // question in working memory; the EMA model trains on every cycle.
  if (CONFIG.predictiveProcessing) {
    try {
      const actual = { topScore: actualTopScore, confidence: errorReport.confidence };
      if (prediction) {
        const sr = computeSurprise(prediction, actual);
        if (sr.surprise > 0) getNeuromodulators().onSurprise(sr.surprise);
        if (sr.knowledgeGap) getBrainState().noteOpenQuestion(req.prompt, cid);
        // Belief seam: strong surprise softly erodes lexically-related beliefs
        // (reality diverged from expectation). Lives inside this EXISTING
        // failure-isolated predictive block — not a new pipeline call site.
        if (sr.surprise >= 0.3) getBeliefEngine().noteSurprise(req.prompt, sr.surprise);
        // ACTIVE INFERENCE (C3) — fold the REALISED surprise back into the
        // foraging policy so it learns which contexts warranted acting. Rides
        // this existing predictive block (it needs the same prediction); a brain
        // with predictiveProcessing off keeps active inference permanently in its
        // warm-start floor — safe, no perturbation.
        if (aiActive && aiCtx && aiPolicy) {
          saveActiveInferenceState(learnActiveInference(aiPolicy, aiCtx, sr.surprise));
        }
      }
      savePredictiveState(observeRetrieval(loadPredictiveState(), req.prompt, actual));
    } catch (err) {
      surfaceError("pipeline.predictiveObserve", err);
    }
  }
  // Feed the completed reasoning cycle to the self-model so its introspection is
  // grounded in what actually happened (confidence + what was cited) instead of
  // being blind to its own reasoning. Failure-isolated: a self-model fault must
  // never break /api/ask, and the engine may be uninitialized in hermetic runs.
  try {
    getSelfConsciousness().react({
      type: "pipeline:reasoning",
      payload: { confidence: errorReport.confidence, citedCount: citedIds.size },
    });
  } catch (err) {
    surfaceError("pipeline.selfConsciousness", err);
  }
  try {
    // Embed the learned Q+A best-effort so it (a) becomes visible to vector
    // search and (b) can later use the cosine novelty/cluster path. embedder is
    // declared at function scope (~line 272).
    let learnedEmbedding: number[] | undefined;
    if (embedder?.embed) {
      try {
        learnedEmbedding = await embedder.embed(`Q: ${req.prompt}\nA: ${finalAnswer}`);
      } catch {
        // best-effort; store without a vector (falls back to string similarity)
      }
    }
    // Drop a wrong-dim vector rather than let upsertMemoryPoint's hard dim-check
    // throw — that throw would escape to the outer catch and silently DROP the
    // whole learned memory (no insert, no processNewMemory, no citation graph).
    // Happens if the embed model is swapped or EMBEDDING_DIM is misconfigured.
    if (learnedEmbedding && learnedEmbedding.length !== CONFIG.embeddingDim) {
      learnedEmbedding = undefined;
    }
    const learned = upsertMemoryPoint({
      sourceType: "conversation",
      filePath: null,
      projectName: projectName ?? "(conversation)",
      title: req.prompt.slice(0, 80),
      content: `Q: ${req.prompt}\nA: ${finalAnswer}`,
      contentHash: sha1(`${req.prompt}|${finalAnswer}`),
      importance: errorReport.confidence,
      embedding: learnedEmbedding,
      // MEMORY DNA — stamp the learned memory with affect + trust + verification
      // (under metadata.dna). Always written (cheap metadata); the retrieval
      // demotion that reads it is separately gated by CONFIG.memoryDna.
      metadata: mergeDna(
        { conversationId: cid, runId },
        deriveDna({
          source: "conversation",
          confidence: calibratedConfidence,
          citedCount: citedIds.size,
          emotion: citedIds.size > 0 ? Math.min(1, 0.5 + 0.2 * calibratedConfidence) : 0.45,
        }),
      ),
    });
    const memoryContext = processNewMemory(
      learned.content,
      projectName ?? null,
      learned.id,
    );
    if (memoryContext.noveltyCategory === "novel") {
      updateMemoryImportance(learned.id, learned.importance + memoryContext.importanceBoost);
    }
    // "cites" now means cited, not retrieved — the relation graph stops lying.
    const scoreById = new Map(
      memoryHits.map((h) => [h.memory.id, h.score] as const),
    );
    for (const citedId of citedIds) {
      try {
        insertRelation(learned.id, citedId, "cites", scoreById.get(citedId) ?? 0.5);
      } catch {
        // ignore relation failures
      }
    }
  } catch (err) {
    // Learning is best-effort; surface but don't fail the run.
    console.warn("[pipeline] learning persistence failed:", err);
  }
  // Persist the training snapshot (feature vectors + cited ids) keyed by runId
  // so a later explicit 👍/👎 (POST /api/feedback) can retrain against the same
  // features that produced this ranking. Best-effort — never break the run.
  // Training signal uses faithfulCitedIds — citations the faithfulness check did
  // NOT flag as unsupported (identical to citedIds when the flag is off / nothing
  // flagged), so the ranker/reranker stop rewarding mere citation PRESENCE.
  try {
    recordRankTrainingLog(runId, rankFeatures, faithfulCitedIds);
  } catch (err) {
    console.warn("[pipeline] rank-training-log persist failed:", err);
  }
  // Online ranker update from this query's implicit feedback. Independent of
  // persistence success; no-op when there were no citations.
  trainFromCitations(rankFeatures, faithfulCitedIds);
  // HEBBIAN — memories cited TOGETHER in this answer wire together
  // ("associates" edges; faithfulness-filtered so unfaithful citations don't
  // reinforce associations). Internally bounded + failure-isolated.
  recordCoCitations([...faithfulCitedIds]);
  // Online lexical-reranker update on the SAME dense citation signal (cited=1 /
  // shown-but-not-cited=0). Best-effort; no-op when there were no citations.
  if (CONFIG.rerankerEnabled) {
    try {
      saveRerankerState(trainReranker(req.prompt, memoryHits, faithfulCitedIds, loadRerankerState()));
    } catch (err) {
      surfaceError("pipeline.trainReranker", err);
    }
  }
  // RL controller reward — the DENSE citation signal (NOT scarce 👍/👎). Coverage
  // is the fraction of the hits the LLM actually read that earned a citation;
  // webCitationUsed sharpens the augment slot. Only when the controller decided
  // this run (so it's a strict no-op when ADAPTIVE_CONTROLLER is off).
  if (CONFIG.adaptiveController && controllerDecision && controllerCtx) {
    applyControllerReward(
      controllerDecision,
      controllerCtx,
      computeControllerOutcome(citedIds, promptHits.length, webHitIds),
    );
  }
  // FABLE F3 — record this cycle's depth outcome so the adaptive-compute gate
  // learns what's actually easy (warm-start floor keeps it a no-op until it has
  // data). route.depth reflects any F1 escalation. Failure-isolated; strict
  // no-op when ADAPTIVE_DEPTH is off.
  if (CONFIG.adaptiveDepth) {
    try {
      saveAdaptiveDepthState(
        observeDepthOutcome(loadAdaptiveDepthState(), {
          depth: route.depth,
          citedCount: citedIds.size,
        }),
      );
    } catch (err) {
      surfaceError("pipeline.adaptiveDepthObserve", err);
    }
  }
  completePipelineRun(runId, finalAnswer);
  // Background consolidation (replay, novelty, prefetch). Best-effort and runs
  // after the answer has streamed, so float it with a .catch() — an error here
  // must never reject into the request handler or crash the process.
  void onConversationMessage({
    lastMemories: Array.from(citedIds),
    projectName: projectName ?? null,
    query: req.prompt,
  }).catch((err) => {
    console.warn("[pipeline] background consolidation failed:", err);
  });
  try {
    broadcast({ type: "memory-count", count: getMemoryCount() });
  } catch (err) {
    // Best-effort broadcast — but a failing getMemoryCount() is the first sign
    // the SQLite handle is in a bad state, so don't swallow it entirely.
    console.warn("[pipeline] memory-count broadcast failed:", err);
  }
  emitAll(
    makeEvent(cid, runId, "learning", "complete", {
      detail: "Stored conversation memory",
      finalAnswer,
    }),
    emit,
  );
}
