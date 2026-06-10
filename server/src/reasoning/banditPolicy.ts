// Contextual linear bandit (RL + ML). The controller's decision is FACTORED into
// independent per-slot bandits (augment / retrievalK / multiQuery / modelProfile);
// each slot is a set of discrete ARMS, and each arm carries a small online linear
// model (LMS regression) predicting the expected reward in a given context. Arm
// selection is ε-greedy on that predicted reward.
//
// PURE (no DB, no network, no clock) — the rl:selfcheck target. Persistence lives
// in db/repositories/adaptive.ts; the citation-anchored reward + heuristic
// baselines live in reasoning/adaptiveController.ts.
//
// THE NO-REGRESSION FLOOR. Below `warmAt` real observations a slot returns
// EXACTLY the heuristic arm with NO exploration — so on a single-user brain (where
// reward is scarce) the policy is structurally incapable of degrading the live
// /api/ask experience until it has actually watched the heuristic enough to have
// a baseline. Exploration only begins after that, and only when the operator has
// opted in (ADAPTIVE_CONTROLLER=true).

import type { RetrievalContext, ControllerSlot } from "../../../shared/adaptive.js";

export interface ArmModel {
  weights: number[]; // length === CTX_DIM, LMS over contextFeatures
  pulls: number;
}
export interface SlotState {
  arms: Record<string, ArmModel>;
  totalPulls: number;
}
export interface BanditState {
  version: number;
  slots: Record<string, SlotState>;
}

export const BANDIT_VERSION = 1;
const CTX_DIM = 6;
const DEFAULT_LR = 0.1;
const DEFAULT_EPSILON = 0.1;

export function emptyBanditState(): BanditState {
  return { version: BANDIT_VERSION, slots: {} };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

// Cheap, bounded context features (with bias). Deterministic + pure.
export function contextFeatures(ctx: RetrievalContext): number[] {
  return [
    1,
    Math.min(1, Math.max(0, ctx.localHitCount / 10)),
    clamp01(ctx.topLocalScore),
    Math.min(1, Math.max(0, ctx.queryLength / 20)),
    ctx.timeSensitive ? 1 : 0,
    ctx.hybridAvailable ? 1 : 0,
  ];
}

function dot(w: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length && i < x.length; i += 1) s += w[i] * x[i];
  return s;
}

// Predicted reward for (slot, arm) in this context. An UNSEEN arm predicts 0
// (neutral) — so a warm slot keeps exploiting the heuristic arm it has learned
// about until ε-exploration samples the others.
export function predictReward(
  state: BanditState,
  slot: ControllerSlot,
  armKey: string,
  ctx: RetrievalContext,
): number {
  const arm = state.slots[slot]?.arms[armKey];
  if (!arm) return 0;
  return dot(arm.weights, contextFeatures(ctx));
}

export interface SelectResult {
  arm: string;
  source: "heuristic" | "policy";
}

export interface SelectOptions {
  warmAt: number;
  epsilon?: number;
  rng?: () => number; // injectable for deterministic tests
}

// ε-greedy with the warm-start floor. Below `warmAt` total observations for the
// slot, returns the heuristic arm with NO exploration (source:"heuristic").
export function selectArm(
  state: BanditState,
  slot: ControllerSlot,
  armKeys: string[],
  ctx: RetrievalContext,
  heuristicArm: string,
  opts: SelectOptions,
): SelectResult {
  const total = state.slots[slot]?.totalPulls ?? 0;
  if (total < opts.warmAt) {
    return { arm: heuristicArm, source: "heuristic" };
  }
  const rng = opts.rng ?? Math.random;
  const epsilon = opts.epsilon ?? DEFAULT_EPSILON;
  if (armKeys.length > 1 && rng() < epsilon) {
    const arm = armKeys[Math.floor(rng() * armKeys.length)] ?? heuristicArm;
    return { arm, source: "policy" };
  }
  // Exploit: argmax predicted reward, with the heuristic arm as the tie-break
  // seed (so a never-pulled-better arm doesn't displace the heuristic on a tie).
  let best = heuristicArm;
  let bestVal = predictReward(state, slot, heuristicArm, ctx);
  for (const k of armKeys) {
    const v = predictReward(state, slot, k, ctx);
    if (v > bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return { arm: best, source: "policy" };
}

// Online LMS update of one arm's linear model toward the observed reward.
// Returns a NEW state (the caller persists it). Reward is clamped to [0,1].
export function updateArm(
  state: BanditState,
  slot: ControllerSlot,
  armKey: string,
  ctx: RetrievalContext,
  reward: number,
  opts: { lr?: number } = {},
): BanditState {
  const lr = opts.lr ?? DEFAULT_LR;
  const x = contextFeatures(ctx);
  const slots = { ...state.slots };
  const prev = slots[slot];
  const slotState: SlotState = prev
    ? { arms: { ...prev.arms }, totalPulls: prev.totalPulls }
    : { arms: {}, totalPulls: 0 };
  const prevArm = slotState.arms[armKey];
  const arm: ArmModel = prevArm
    ? { weights: [...prevArm.weights], pulls: prevArm.pulls }
    : { weights: new Array<number>(CTX_DIM).fill(0), pulls: 0 };
  if (arm.weights.length !== CTX_DIM) arm.weights = new Array<number>(CTX_DIM).fill(0);
  const err = clamp01(reward) - dot(arm.weights, x);
  arm.weights = arm.weights.map((w, i) => w + lr * err * (x[i] ?? 0));
  arm.pulls += 1;
  slotState.arms[armKey] = arm;
  slotState.totalPulls += 1;
  slots[slot] = slotState;
  return { version: BANDIT_VERSION, slots };
}
