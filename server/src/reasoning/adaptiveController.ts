// The RL-adaptive RAG controller. Turns the pipeline's hand-tuned retrieval gates
// (web-augment / retrieval-k / multi-query / model-routing) into POLICY-backed
// decisions that learn from the dense citation-usage reward — while warm-starting
// at the heuristics so the live path can't regress before the policy has learned.
//
// FLOW (single /api/ask, in-process, no decision log persisted):
//   memory step  → decide(ctx, heuristicBaseline) → ControllerDecision
//   learning step→ reward(decision, ctx, outcome)  (citation-anchored)
//
// FULLY GATED: only invoked when CONFIG.adaptiveController is true. When off, the
// pipeline uses its heuristics directly and this module is dormant (no reads, no
// writes) — the default path stays byte-identical to today's (+ Phase A/B).

import { CONFIG } from "../config.js";
import {
  RETRIEVAL_K_ARMS,
  type ControllerDecision,
  type ControllerOutcome,
  type ControllerSlot,
  type RetrievalContext,
} from "../../../shared/adaptive.js";
import { MODEL_PROFILES, type ModelProfile } from "../../../shared/models.js";
import {
  DEFAULT_EPSILON,
  emptyBanditState,
  selectArm,
  updateArm,
  type BanditState,
} from "./banditPolicy.js";
import { loadBanditState, saveBanditState } from "../db/repositories/adaptive.js";
import { getCognitiveDna, explorationEpsilonScale } from "../core/cognitiveDna.js";
import { surfaceError } from "../util/diagnostics.js";

// The heuristic decision the pipeline would make without the controller — the
// warm-start baseline each slot returns until it's warm.
export interface HeuristicBaseline {
  augment: boolean;
  retrievalK: number;
  multiQuery: boolean;
  modelProfile: ModelProfile;
}

const AUGMENT_ARMS = ["false", "true"];
const K_ARMS = RETRIEVAL_K_ARMS.map(String);
const MQ_ARMS = ["false", "true"];
const PROFILE_ARMS = [...MODEL_PROFILES];

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function heuristicDecision(heur: HeuristicBaseline): ControllerDecision {
  const heuristicSource: Record<ControllerSlot, "heuristic" | "policy"> = {
    augment: "heuristic",
    retrievalK: "heuristic",
    multiQuery: "heuristic",
    modelProfile: "heuristic",
  };
  return {
    augmentWeb: heur.augment,
    retrievalK: heur.retrievalK,
    multiQuery: heur.multiQuery,
    modelProfile: heur.modelProfile,
    source: heuristicSource,
  };
}

// Choose each slot's action. Pure decision logic over the persisted bandit state;
// warm-start floor lives in selectArm. Never throws — any failure falls back to
// the heuristic baseline so the pipeline always gets a usable decision.
export function decide(ctx: RetrievalContext, heur: HeuristicBaseline): ControllerDecision {
  try {
    const state: BanditState = loadBanditState() ?? emptyBanditState();
    const warmAt = CONFIG.banditWarmAt;
    // COGNITIVE DNA — a bold character explores more arms, a cautious one fewer.
    // Scales the ε ONLY; the warm-start floor in selectArm still returns the
    // heuristic with NO exploration below warmAt, so risk can never make a cold
    // slot gamble. Exactly DEFAULT_EPSILON at the neutral trait. Failure-isolated.
    let epsilon = DEFAULT_EPSILON;
    try {
      epsilon = DEFAULT_EPSILON * explorationEpsilonScale(getCognitiveDna().traits());
    } catch (err) {
      surfaceError("adaptiveController.dnaEpsilon", err);
    }
    const armOpts = { warmAt, epsilon };
    const source: Record<ControllerSlot, "heuristic" | "policy"> = {
      augment: "heuristic",
      retrievalK: "heuristic",
      multiQuery: "heuristic",
      modelProfile: "heuristic",
    };

    // Augment: "true" is only a legal arm when the web is actually reachable
    // (LOCAL_ONLY=false + hybrid on). Otherwise force false — both for egress
    // safety and because there's nothing to learn.
    let augmentWeb = false;
    if (ctx.hybridAvailable) {
      const r = selectArm(state, "augment", AUGMENT_ARMS, ctx, String(heur.augment), armOpts);
      augmentWeb = r.arm === "true";
      source.augment = r.source;
    }

    const kr = selectArm(state, "retrievalK", K_ARMS, ctx, String(heur.retrievalK), armOpts);
    const kNum = Number(kr.arm);
    const retrievalK = (RETRIEVAL_K_ARMS as readonly number[]).includes(kNum) ? kNum : heur.retrievalK;
    source.retrievalK = kr.source;

    const mqr = selectArm(state, "multiQuery", MQ_ARMS, ctx, String(heur.multiQuery), armOpts);
    const multiQuery = mqr.arm === "true";
    source.multiQuery = mqr.source;

    const pr = selectArm(state, "modelProfile", PROFILE_ARMS, ctx, heur.modelProfile, armOpts);
    const modelProfile = (MODEL_PROFILES as string[]).includes(pr.arm) ? (pr.arm as ModelProfile) : heur.modelProfile;
    source.modelProfile = pr.source;

    return { augmentWeb, retrievalK, multiQuery, modelProfile, source };
  } catch (err) {
    surfaceError("adaptiveController.decide", err);
    return heuristicDecision(heur);
  }
}

// Derive the dense citation-usage outcome from a finished run. PURE (selfcheck
// target). Coverage = fraction of the hits the LLM READ that earned a citation;
// webCitationUsed = did any FUSED WEB hit get cited (sharpens the augment slot).
export function computeControllerOutcome(
  citedIds: Set<string>,
  promptHitCount: number,
  webHitIds: Set<string>,
): ControllerOutcome {
  let webCitationUsed = false;
  for (const id of citedIds) {
    if (webHitIds.has(id)) {
      webCitationUsed = true;
      break;
    }
  }
  return {
    citationCoverage: promptHitCount > 0 ? Math.min(1, citedIds.size / promptHitCount) : 0,
    webCitationUsed,
    citedCount: citedIds.size,
  };
}

// The augment slot's reward, sharpened on web-citation usage (its highest-signal
// outcome): augmenting that yielded a CITED web hit is a strong positive; paying
// for the web and NOT using it is a mild negative; not augmenting → base. PURE.
export function augmentSlotReward(augmentWeb: boolean, base: number, webCitationUsed: boolean): number {
  const b = clamp01(base);
  if (!augmentWeb) return b;
  return webCitationUsed ? Math.max(b, 0.8) : Math.min(b, 0.3);
}

// Apply the dense citation-usage reward to each slot's pulled arm. Base reward is
// citation coverage; the augment slot is SHARPENED via augmentSlotReward. Never throws.
export function reward(decision: ControllerDecision, ctx: RetrievalContext, outcome: ControllerOutcome): void {
  try {
    let state: BanditState = loadBanditState() ?? emptyBanditState();
    const base = clamp01(outcome.citationCoverage);
    state = updateArm(state, "augment", String(decision.augmentWeb), ctx, augmentSlotReward(decision.augmentWeb, base, outcome.webCitationUsed));
    state = updateArm(state, "retrievalK", String(decision.retrievalK), ctx, base);
    state = updateArm(state, "multiQuery", String(decision.multiQuery), ctx, base);
    state = updateArm(state, "modelProfile", decision.modelProfile, ctx, base);
    saveBanditState(state);
  } catch (err) {
    surfaceError("adaptiveController.reward", err);
  }
}

// Build the decision-time context from the baseline local retrieval. Pure.
export function buildRetrievalContext(
  query: string,
  localHits: { score: number }[],
  hybridAvailable: boolean,
): RetrievalContext {
  return {
    localHitCount: localHits.length,
    topLocalScore: localHits[0]?.score ?? 0,
    queryLength: query.trim().split(/\s+/).filter(Boolean).length,
    timeSensitive: /\b(latest|today|now|current|recent|news|price|weather|version|update|2[01]\d\d)\b/i.test(query),
    hybridAvailable,
  };
}
