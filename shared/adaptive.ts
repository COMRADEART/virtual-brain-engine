// Contracts for the RL-adaptive RAG controller (the "learns when/how to retrieve"
// layer). PURE types + plain constants only — zero runtime deps — so both the
// Vite client and the Node server import them without a build step, exactly like
// the other shared/ contracts.
//
// The controller turns the pipeline's hand-tuned retrieval gates (shouldAugment,
// retrieval-k, model routing) into POLICY-backed decisions that can learn from
// the dense citation-usage reward. Until a slot has accumulated enough real
// observations it returns EXACTLY the heuristic decision (no exploration), so it
// is structurally incapable of regressing the live /api/ask experience.

import type { ModelProfile } from "./models.js";

// The four decision slots the controller owns. Each is an independent contextual
// bandit so reward attribution stays tractable (one run-level reward updates the
// arm each slot actually pulled). Ordered by signal strength: augment is the
// highest-signal slot, modelProfile the weakest (a thumbs/citation reward barely
// attributes to model choice — it is included for completeness but warm-starts to
// the existing heuristic and is the last to ever leave it).
export type ControllerSlot = "augment" | "retrievalK" | "multiQuery" | "modelProfile";
export const CONTROLLER_SLOTS: readonly ControllerSlot[] = [
  "augment",
  "retrievalK",
  "multiQuery",
  "modelProfile",
] as const;

// Discrete retrieval-k arms. 8 is the pipeline's historical default (the
// warm-start value); the policy may learn to retrieve fewer when local memory is
// strong, or more when it's thin.
export const RETRIEVAL_K_ARMS = [6, 8, 12] as const;
export const DEFAULT_RETRIEVAL_K = 8;

// Cheap, local features the policy + heuristics see at decision time. No network,
// no LLM — assembled from the local vector hits already in hand.
export interface RetrievalContext {
  localHitCount: number; // # local vector hits before any augmentation
  topLocalScore: number; // best local vec score, [0,1]
  queryLength: number; // word-ish length of the query
  timeSensitive: boolean; // freshness smell (latest/today/price/…)
  hybridAvailable: boolean; // LOCAL_ONLY=false + HYBRID_RESEARCH on + mode≠off
}

export interface ControllerDecision {
  augmentWeb: boolean;
  retrievalK: number; // one of RETRIEVAL_K_ARMS
  multiQuery: boolean;
  modelProfile: ModelProfile;
  // Per-slot provenance for telemetry: did a (warm) policy choose it, or did the
  // slot fall back to the heuristic? Lets the UI/logs show learning progress.
  source: Record<ControllerSlot, "heuristic" | "policy">;
}

// What the learning step hands back so the controller can attribute a dense
// citation-usage reward to each slot's pulled arm. NOT thumbs — citations accrue
// on every query, thumbs almost never (single-user brain).
export interface ControllerOutcome {
  // [0,1]: fraction of prompt hits that earned a citation (coverage).
  citationCoverage: number;
  // Did any FUSED WEB hit get cited? Sharpens the augment slot's reward.
  webCitationUsed: boolean;
  // Total citations the answer actually used.
  citedCount: number;
}
