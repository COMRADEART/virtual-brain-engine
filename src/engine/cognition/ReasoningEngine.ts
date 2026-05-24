// ReasoningEngine — System 2 (slow, deliberate, explainable cognition)
// ====================================================================
//
// System 1 (the spiking network) is fast and intuitive but can be wrong or
// uncertain. System 2 is the slow, effortful path the arbiter recruits when
// System 1 is unsure. It runs at most ~10 Hz, is strictly time-budgeted, and is
// PURE TYPESCRIPT and DETERMINISTIC — no LLM/network call inside the cognitive
// loop (that would add latency and a failure mode mid-step). The server's LLM
// pipeline still informs the brain over the WS bus; it is not duplicated here.
//
// One `deliberate(budgetMs)` runs a small set of human-style reasoning operators
// over a shared "blackboard", in iterative-deepening order, stopping when the
// time budget is spent. Each operator appends a human-readable line to an
// explanation trace — this is the brain's INTROSPECTION / "why did I conclude
// that" capability. The operators:
//
//   • ANALOGICAL reasoning  — matches the current activity signature against a
//     library of remembered patterns and proposes completing the best analogue
//     (structural transfer / pattern completion). With probability set by the
//     exploration temperature it instead reaches for a DISTANT association — the
//     controlled-noise route to creativity.
//   • COUNTERFACTUAL reasoning — asks "had we anticipated the most surprising
//     region, how much would surprise (free energy) have fallen?" and recommends
//     pre-activating it. A lightweight what-if over the predictive model.
//   • THEORY OF MIND — maintains a lagged model of an "other" observer and flags
//     where that other mind would mispredict the current state (perspective
//     taking).
//
// The result is an action/attention BIAS plus a confidence and an explanation,
// which HybridCognitiveCore injects back into System 1 through existing seams
// (setExpectation / applyCognitiveState / flashRegions).

import type { AdvancedBrainCore } from "../AdvancedBrainCore";
import type { BrainEventBus } from "../BrainEventBus";
import { REGION_ORDER } from "../brainRegions";
import type { BrainRegionId } from "../types";
import type { ReasoningResult, ReasoningStep } from "./cognitionTypes";

interface Experience {
  sig: Float32Array; // remembered region-activity signature
  label: string;
  salience: number;
}

const LIBRARY_CAP = 64; // bounded analogue memory
const NOVELTY_STORE_THRESHOLD = 0.6; // below this similarity, remember the state

export class ReasoningEngine {
  private readonly R: number;
  private readonly curSig: Float32Array; // reused scratch (no per-call alloc)
  private readonly otherBelief: Float32Array; // Theory-of-Mind: model of an "other"
  private readonly library: Experience[] = [];

  /** Creativity knob (genome): probability of reaching for a distant association. */
  private explorationTemp = 0.3;
  private deadline = 0;
  private nextLabel = 1;

  constructor(
    private readonly core: AdvancedBrainCore,
    private readonly bus: BrainEventBus,
  ) {
    this.R = REGION_ORDER.length;
    this.curSig = new Float32Array(this.R);
    this.otherBelief = new Float32Array(this.R);
  }

  setExplorationTemp(t: number): void {
    this.explorationTemp = t < 0 ? 0 : t > 1 ? 1 : t;
  }

  // ── One bounded deliberation pass ───────────────────────────────────────────

  deliberate(budgetMs: number): ReasoningResult {
    this.deadline = now() + budgetMs;
    this.snapshotSignature();

    const steps: ReasoningStep[] = [];
    // Iterative deepening: cheap/likely-useful operators first; stop on budget.
    const ops: Array<() => ReasoningStep | null> = [
      () => this.analogical(),
      () => this.counterfactual(),
      () => this.theoryOfMind(),
    ];
    for (const op of ops) {
      if (now() >= this.deadline) break;
      const step = op();
      if (!step) continue;
      steps.push(step);
      this.bus.emit("reason:step", {
        kind: step.kind,
        explain: step.explain,
        depth: steps.length,
        confidence: step.confidence,
      });
    }

    // Always update the Theory-of-Mind model toward reality, even if that op was
    // skipped this pass, so the "other" tracks the world slowly.
    this.relaxOtherBelief();

    return this.aggregate(steps);
  }

  // ── Operators ───────────────────────────────────────────────────────────────

  /** Match the current signature to the library and propose completing it. */
  private analogical(): ReasoningStep | null {
    if (this.library.length === 0) {
      this.maybeRemember(0);
      return null;
    }

    // Distant-association (creative) branch: occasionally pick a RANDOM analogue
    // instead of the nearest one, surfacing a remote connection.
    const creative = Math.random() < this.explorationTemp * 0.5;
    let best = -1;
    let bestSim = -1;
    if (creative) {
      best = Math.floor(Math.random() * this.library.length);
      bestSim = cosine(this.curSig, this.library[best].sig);
    } else {
      for (let i = 0; i < this.library.length; i++) {
        const sim = cosine(this.curSig, this.library[i].sig);
        if (sim > bestSim) {
          bestSim = sim;
          best = i;
        }
      }
    }

    this.maybeRemember(bestSim);
    if (best < 0) return null;

    // Pattern completion: regions strong in the analogue but weak right now are
    // the structural transfer the analogy recommends engaging.
    const analogue = this.library[best].sig;
    const regions = this.topRegionsWhere(analogue, this.curSig, 3);
    const sim = Math.max(0, bestSim);
    return {
      kind: "analogy",
      explain: creative
        ? `analogy(creative): a distant pattern (sim ${sim.toFixed(2)}) suggests engaging ${fmt(regions)}`
        : `analogy: current state ~${sim.toFixed(2)} like prior "${this.library[best].label}"; complete it via ${fmt(regions)}`,
      biasRegions: regions,
      biasStrength: creative ? 0.4 + sim * 0.3 : sim,
      confidence: creative ? 0.35 : sim,
    };
  }

  /** What-if over the predictive model: anticipating the most surprising region. */
  private counterfactual(): ReasoningStep | null {
    let focus = -1;
    let maxErr = 0;
    for (let i = 0; i < this.R; i++) {
      const e = Math.abs(this.core.getRegionError(i));
      if (e > maxErr) {
        maxErr = e;
        focus = i;
      }
    }
    if (focus < 0 || maxErr < 0.05) return null;

    const regionId = REGION_ORDER[focus];
    // The counterfactual gain: had this region been anticipated (its expectation
    // raised to the observed level), the prediction error it contributes would be
    // explained away — surprise would fall by ~maxErr.
    const gain = Math.min(1, maxErr / 1.5);
    return {
      kind: "counterfactual",
      explain: `counterfactual: had ${regionId} been anticipated, surprise would fall ~${maxErr.toFixed(2)}; pre-activate it`,
      biasRegions: [regionId],
      biasStrength: gain,
      confidence: gain,
    };
  }

  /** Flag where a modelled observer would mispredict the current state. */
  private theoryOfMind(): ReasoningStep | null {
    let focus = -1;
    let maxDiv = 0;
    for (let i = 0; i < this.R; i++) {
      const div = Math.abs((this.curSig[i] ?? 0) - this.otherBelief[i]);
      if (div > maxDiv) {
        maxDiv = div;
        focus = i;
      }
    }
    if (focus < 0 || maxDiv < 0.15) return null;

    const regionId = REGION_ORDER[focus];
    return {
      kind: "theory-of-mind",
      explain: `theory-of-mind: an observer here would mispredict ${regionId} (Δ${maxDiv.toFixed(2)}); account for their view`,
      biasRegions: [regionId],
      biasStrength: Math.min(1, maxDiv),
      confidence: Math.min(0.8, maxDiv),
    };
  }

  // ── Blackboard aggregation ──────────────────────────────────────────────────

  private aggregate(steps: ReasoningStep[]): ReasoningResult {
    if (steps.length === 0) {
      return { depth: 0, confidence: 0, explanation: "", biasRegions: [], biasStrength: 0 };
    }
    // Best recommendation = the step with the highest strength×confidence.
    let best = steps[0];
    let bestScore = -1;
    let confSum = 0;
    for (const s of steps) {
      const score = s.biasStrength * s.confidence;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
      confSum += s.confidence;
    }
    return {
      depth: steps.length,
      confidence: confSum / steps.length,
      explanation: steps.map((s) => s.explain).join("  →  "),
      biasRegions: best.biasRegions,
      biasStrength: best.biasStrength,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private snapshotSignature(): void {
    const intensity = this.core.regionIntensity;
    for (let i = 0; i < this.R; i++) this.curSig[i] = intensity[i] ?? 0;
  }

  /** Slowly drag the Theory-of-Mind model toward reality (the "other" lags). */
  private relaxOtherBelief(): void {
    for (let i = 0; i < this.R; i++) {
      this.otherBelief[i] += ((this.curSig[i] ?? 0) - this.otherBelief[i]) * 0.08;
    }
  }

  /** Remember a sufficiently novel current state as a new analogue. */
  private maybeRemember(bestSim: number): void {
    if (bestSim >= NOVELTY_STORE_THRESHOLD) return;
    if (l2(this.curSig) < 0.1) return; // ignore near-silent states
    const sig = this.curSig.slice();
    this.library.push({ sig, label: `pattern-${this.nextLabel++}`, salience: l2(sig) });
    if (this.library.length > LIBRARY_CAP) {
      // Evict the least salient remembered pattern.
      let weakest = 0;
      for (let i = 1; i < this.library.length; i++) {
        if (this.library[i].salience < this.library[weakest].salience) weakest = i;
      }
      this.library.splice(weakest, 1);
    }
  }

  /** Regions strong in `target` but weak in `current`, ranked by the gap. */
  private topRegionsWhere(target: Float32Array, current: Float32Array, k: number): BrainRegionId[] {
    const gaps: Array<{ i: number; gap: number }> = [];
    for (let i = 0; i < this.R; i++) {
      const gap = target[i] - (current[i] ?? 0);
      if (gap > 0.1) gaps.push({ i, gap });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    return gaps.slice(0, k).map((g) => REGION_ORDER[g.i]);
  }

  getLibrarySize(): number {
    return this.library.length;
  }
}

// ── Pure vector helpers ───────────────────────────────────────────────────────

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-6 ? dot / denom : 0;
}

function l2(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

function fmt(regions: BrainRegionId[]): string {
  return regions.length ? regions.join(", ") : "(none)";
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
