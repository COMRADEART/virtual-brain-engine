// HybridCognitiveCore — dual-process orchestrator over the spiking brain
// ======================================================================
//
// This is the top of the cognitive stack. It COMPOSES an AdvancedBrainCore
// (System 1 — the fast, intuitive spiking network) and bolts on the slow,
// deliberate machinery (System 2 reasoning, reinforcement learning, and
// meta-learning). It IMPLEMENTS the renderer's `BrainSimulation` contract BY
// DELEGATION, so it drops into BrainScene exactly where the engine plugs in today
// — the renderer reads the inner core's buffers through these getters and never
// knows a wrapper is present. The just-stabilised dynamics are untouched.
//
// THE LOOP (one `step(dt, elapsed)`):
//   1. System 1 advances every frame (the mandatory, real-time path).
//   2. ARBITRATION computes an uncertainty signal (surprise + reward volatility +
//      criticality drift + arousal). If it exceeds the (meta-learned) threshold,
//      System 2 is engaged.
//   3. When engaged, a time-budgeted deliberation runs at ≤10 Hz and its result
//      biases System 1 through existing seams (setExpectation / FOCUS state /
//      flashRegions).
//   4. Reinforcement updates every frame: reward-prediction error → dopamine →
//      three-factor plasticity.
//   5. Meta-learning ticks within whatever per-frame budget remains, never
//      blocking the 60 Hz render path.
//
// Performance: only step (1) is per-frame heavy. (3)/(5) are time-sliced under a
// hard budget; (4) is O(1)-ish. No new per-frame GPU work and no per-frame React
// state — the HUD subscribes to the bus at ~10 Hz.

import { AdvancedBrainCore, type ReplayEvent } from "../AdvancedBrainCore";
import type { BrainEventBus } from "../BrainEventBus";
import { subscribeBrainBus } from "../brainBus";
import { FOCUS_STATE } from "../cognitiveStates";
import type { CognitiveState } from "../cognitiveStates";
import type {
  BrainActionId,
  BrainRegionId,
  BrainSimulation,
  NeuralGraph,
  SignalPulse,
} from "../types";
import type { LogicalRegionId } from "../../../shared/pipeline";
import type { BrainSnapshot } from "../../../shared/brainSnapshot";
import { MetaLearningSystem } from "./MetaLearningSystem";
import { ReasoningEngine } from "./ReasoningEngine";
import { ReinforcementSystem } from "./ReinforcementSystem";
import { isPersistenceAvailable, loadSnapshot, saveSnapshot } from "./persistence";
import type { Affect, ArbitrationDecision, CognitiveMode, IQReport } from "./cognitionTypes";

export interface HybridCognitiveOptions {
  /** Density + seed of the graph — required for cross-session persistence. */
  density?: number;
  seed?: number;
  /** Subscribe to the WS pipeline as an extrinsic reward source (default true). */
  attachRewardSource?: boolean;
}

const SLOW_DT = 0.1; // System 2 deliberates at most ~10 Hz
const SLOW_FRAME_BUDGET_MS = 2.5; // hard cap on slow cognition per frame
const SAVE_THROTTLE_MS = 15000; // at most one IndexedDB write per 15 s

export class HybridCognitiveCore implements BrainSimulation {
  // ── Subsystems ──────────────────────────────────────────────────────────────
  private readonly core: AdvancedBrainCore;
  private readonly rl: ReinforcementSystem;
  private readonly reasoning: ReasoningEngine;
  private readonly meta: MetaLearningSystem;
  readonly bus: BrainEventBus;

  // ── State ───────────────────────────────────────────────────────────────────
  private mode: CognitiveMode = "system1";
  private uncertainty = 0;
  private slowAccum = 0;
  private lastExplanation = "";
  private wasDeliberating = false;

  private readonly density: number;
  private readonly seed: number;
  private readonly persistenceEnabled: boolean;
  private lastSaveMs = 0;

  private readonly disposers: Array<() => void> = [];

  // ── Active-instance registry (so the HUD can find the live engine without
  //    threading props through App → BrainScene) ───────────────────────────────
  private static activeInstance: HybridCognitiveCore | null = null;
  private static activeListeners = new Set<(e: HybridCognitiveCore | null) => void>();

  constructor(graph: NeuralGraph, actionId: BrainActionId, opts: HybridCognitiveOptions = {}) {
    this.core = new AdvancedBrainCore(graph, actionId);
    this.bus = this.core.bus;
    this.rl = new ReinforcementSystem(this.core, this.bus);
    this.reasoning = new ReasoningEngine(this.core, this.bus);
    this.meta = new MetaLearningSystem(this.core, this.rl, this.reasoning, this.bus);

    this.density = opts.density ?? 0;
    this.seed = opts.seed ?? 0;
    this.persistenceEnabled = isPersistenceAvailable() && this.density > 0;

    // Restore learned state (gated on exact topology) — async, off the frame path.
    if (this.persistenceEnabled) {
      void loadSnapshot(this.density, this.seed)
        .then((snap) => snap && this.applySnapshot(snap))
        .catch(() => {
          /* corrupt/old snapshot → keep the freshly-built brain */
        });
    }

    // Autosave when a new IQ report lands (throttled).
    this.disposers.push(this.bus.on("meta:iq", () => this.scheduleSave()));

    // Extrinsic reward from the server pipeline: a finished answer is a small
    // reward; a surfaced error is a small penalty. Guarded for non-browser envs.
    if (opts.attachRewardSource !== false && typeof window !== "undefined") {
      this.disposers.push(
        subscribeBrainBus((msg) => {
          if (msg.type !== "pipeline" || msg.status !== "complete") return;
          if (msg.step === "response") this.rl.addExtrinsicReward(0.8, "response-complete");
          else if (msg.step === "error") this.rl.addExtrinsicReward(-0.4, "error-step");
        }),
      );
    }

    HybridCognitiveCore.setActive(this);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Simulation step
  // ════════════════════════════════════════════════════════════════════════

  step(deltaSeconds: number, elapsedSeconds: number): void {
    // 1) System 1 — mandatory, every frame.
    this.core.step(deltaSeconds, elapsedSeconds);

    // Slow cognition shares one hard time budget so the frame never stalls.
    const slowStart = now();

    // 2) Arbitrate: should we think slowly this frame?
    this.uncertainty = this.computeUncertainty();
    const decision = this.arbitrate(this.uncertainty);
    if (decision.mode !== this.mode) {
      this.mode = decision.mode;
      this.bus.emit("cognition:mode", { mode: this.mode, uncertainty: this.uncertainty });
    }

    // 3) System 2 — deliberate (time-sliced) and bias System 1 with the result.
    this.slowAccum += deltaSeconds;
    if (decision.engageSystem2 && this.slowAccum >= SLOW_DT) {
      this.slowAccum = 0;
      const result = this.reasoning.deliberate(decision.budgetMs);
      this.applyReasoningBias(result, decision.mode);
      this.meta.noteReasoning(result.depth, result.confidence);
      this.lastExplanation = result.explanation;
    }
    this.wasDeliberating = decision.engageSystem2;

    // 4) Reinforcement — reward-prediction error → dopamine → plasticity.
    this.rl.update(deltaSeconds);

    // 5) Meta-learning — only with leftover budget; it's cheap but never urgent.
    if (now() - slowStart < SLOW_FRAME_BUDGET_MS) this.meta.tick(deltaSeconds);
  }

  // ── Arbitration ─────────────────────────────────────────────────────────────

  /** Scalar [0,1]: how much System 1 is out of its depth right now. */
  private computeUncertainty(): number {
    const feN = Math.min(1, this.core.getFreeEnergy() / 8); // surprise
    const vol = Math.min(1, this.rl.getRpeVolatility() * 4); // reward unpredictability
    const critDev = 1 - this.core.getCriticalityScore(); // drift from σ≈1
    const arousal = this.rl.getAffect().arousal; // affective load
    return Math.min(1, 0.5 * feN + 0.25 * vol + 0.15 * critDev + 0.1 * arousal);
  }

  private arbitrate(u: number): ArbitrationDecision {
    const g = this.meta.getLiveGenome();
    const engage = u >= g.arbitrationThreshold;
    const mode: CognitiveMode = engage ? (u > 0.75 ? "system2" : "hybrid") : "system1";
    return { mode, engageSystem2: engage, budgetMs: g.system2BudgetMs, uncertainty: u };
  }

  /** Fold a deliberation result back into System 1 via existing seams. */
  private applyReasoningBias(
    result: { biasRegions: BrainRegionId[]; biasStrength: number; depth: number },
    mode: CognitiveMode,
  ): void {
    if (result.depth === 0) return;
    // Top-down expectation + a soft attentional flash on each recommended region.
    for (const region of result.biasRegions) {
      this.core.setExpectation(region, Math.min(1.2, 0.4 + result.biasStrength));
    }
    if (result.biasRegions.length) {
      this.core.flashRegions(result.biasRegions, 0.35 + 0.4 * result.biasStrength);
    }
    // Engaging System 2 carries the cognitive "set" of focused attention. Apply it
    // only on the transition into deliberation so we don't thrash neuromod tone.
    if (mode === "system2" && !this.wasDeliberating) {
      this.core.applyCognitiveState(FOCUS_STATE);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Persistence
  // ════════════════════════════════════════════════════════════════════════

  serialize(): BrainSnapshot {
    const core = this.core.serializeCore();
    return {
      version: 2,
      density: this.density,
      graphSeed: this.seed,
      savedAt: new Date().toISOString(),
      connectomeWeights: core.connectomeWeights,
      neuromod: core.neuromod,
      valueFunction: this.rl.exportValue(),
      hyperparams: this.meta.exportGenome(),
      iqHistory: this.meta.exportIqHistory(),
      ewcImportance: this.meta.exportImportance(),
    };
  }

  private applySnapshot(s: BrainSnapshot): boolean {
    if (s.version !== 2 || s.density !== this.density || s.graphSeed !== this.seed) return false;
    if (!this.core.loadCoreState({ connectomeWeights: s.connectomeWeights, neuromod: s.neuromod })) {
      return false;
    }
    this.rl.importValue(s.valueFunction);
    this.meta.importGenome(s.hyperparams);
    this.meta.importIqHistory(s.iqHistory);
    this.meta.importImportance(s.ewcImportance);
    return true;
  }

  private scheduleSave(): void {
    if (!this.persistenceEnabled) return;
    const t = Date.now();
    if (t - this.lastSaveMs < SAVE_THROTTLE_MS) return;
    this.lastSaveMs = t;
    void saveSnapshot(this.serialize()).catch(() => {
      /* storage full / blocked — non-fatal */
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Cognition accessors (read by CognitivePanel / diagnostics)
  // ════════════════════════════════════════════════════════════════════════

  getCore(): AdvancedBrainCore {
    return this.core;
  }
  getCognitiveMode(): CognitiveMode {
    return this.mode;
  }
  getUncertainty(): number {
    return this.uncertainty;
  }
  getIQReport(): IQReport {
    return this.meta.getIQReport();
  }
  getAffect(): Readonly<Affect> {
    return this.rl.getAffect();
  }
  getLastDelta(): number {
    return this.rl.getLastDelta();
  }
  getLastExplanation(): string {
    return this.lastExplanation;
  }
  getGeneration(): number {
    return this.meta.getGeneration();
  }

  /** Report an extrinsic reward from the app/UI (e.g. a "good answer" button). */
  reportReward(value: number, reason = "manual"): void {
    this.rl.addExtrinsicReward(value, reason);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  BrainSimulation surface — delegated to the inner core
  // ════════════════════════════════════════════════════════════════════════

  get regionIntensity(): Float32Array {
    return this.core.regionIntensity;
  }
  get regionFlashIntensity(): Float32Array {
    return this.core.regionFlashIntensity;
  }
  get pathwayIntensity(): Float32Array {
    return this.core.pathwayIntensity;
  }
  get pulses(): readonly SignalPulse[] {
    return this.core.pulses;
  }
  get memoryIntensity(): number {
    return this.core.memoryIntensity;
  }
  get membranePotentialNorm(): Float32Array {
    return this.core.membranePotentialNorm;
  }

  // ── Spiking-capable surface (so isSpikingCapable() passes through the wrapper) ─
  get neuronType(): Int8Array {
    return this.core.neuronType;
  }
  get dopamine(): number {
    return this.core.dopamine;
  }
  get acetylcholine(): number {
    return this.core.acetylcholine;
  }
  get serotonin(): number {
    return this.core.serotonin;
  }
  get norepinephrine(): number {
    return this.core.norepinephrine;
  }
  get thetaPhase(): number {
    return this.core.thetaPhase;
  }
  get gammaPhase(): number {
    return this.core.gammaPhase;
  }
  getBurstStatus(): Float32Array | null {
    return this.core.getBurstStatus();
  }
  getMemoryTrace(): Float32Array | null {
    return this.core.getMemoryTrace();
  }

  // ── Control surface — delegated ──────────────────────────────────────────────
  setRunning(running: boolean): void {
    this.core.setRunning(running);
  }
  setSpeed(speed: number): void {
    this.core.setSpeed(speed);
  }
  setMaxPulses(maxPulses: number): void {
    this.core.setMaxPulses(maxPulses);
  }
  setAction(actionId: BrainActionId): void {
    this.core.setAction(actionId);
  }
  setMemoryIntensity(count: number): void {
    this.core.setMemoryIntensity(count);
  }
  flashRegions(regionIds: BrainRegionId[], magnitude = 0.85): void {
    this.core.flashRegions(regionIds, magnitude);
  }
  flashLogicalRegion(id: LogicalRegionId, magnitude = 0.85): void {
    this.core.flashLogicalRegion(id, magnitude);
  }
  applyCognitiveState(state: CognitiveState): void {
    this.core.applyCognitiveState(state);
  }
  injectSensoryText(text: string, surprise = false): void {
    this.core.injectSensoryText(text, surprise);
  }
  triggerMemoryReplay(): void {
    this.core.triggerMemoryReplay();
  }
  handleReplayEvent(event: ReplayEvent): void {
    this.core.handleReplayEvent(event);
  }
  setDopamine(v: number): void {
    this.core.setDopamine(v);
  }
  setAcetylcholine(v: number): void {
    this.core.setAcetylcholine(v);
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────
  dispose(): void {
    if (this.persistenceEnabled) {
      void saveSnapshot(this.serialize()).catch(() => {});
    }
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    if (HybridCognitiveCore.activeInstance === this) HybridCognitiveCore.setActive(null);
  }

  // ── Static active-instance registry ──────────────────────────────────────────
  static getActive(): HybridCognitiveCore | null {
    return HybridCognitiveCore.activeInstance;
  }
  static subscribeActive(cb: (e: HybridCognitiveCore | null) => void): () => void {
    HybridCognitiveCore.activeListeners.add(cb);
    cb(HybridCognitiveCore.activeInstance);
    return () => HybridCognitiveCore.activeListeners.delete(cb);
  }
  private static setActive(e: HybridCognitiveCore | null): void {
    HybridCognitiveCore.activeInstance = e;
    for (const l of HybridCognitiveCore.activeListeners) l(e);
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
