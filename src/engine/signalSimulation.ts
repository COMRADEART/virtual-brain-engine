import { ACTION_BY_ID, REGION_INDEX } from "./brainRegions";
import { LOGICAL_REGION_MAP } from "./logicalRegions";
import * as emergentActions from "./emergentActions";
import type { LogicalRegionId } from "../../shared/pipeline";
import type {
  BrainActionId,
  BrainRegionId,
  NeuralGraph,
  SignalPulse,
  SynapticPathway,
} from "./types";
import type { ReplayEvent } from "../../shared/replay";

const DEFAULT_MAX_PULSES = 260;

// Stub oscillation phases for SignalSimulation (no bio-physical oscillation model).
// SpikingEngine drives real theta/gamma phases; these are just static defaults so
// BrainVisualEffects can read the same interface from either engine.
const STUB_THETA_PHASE = 0;
const STUB_GAMMA_PHASE = 0;

function weightedPick<T>(items: T[], weights: number[], random: () => number): T | undefined {
  let total = 0;
  for (const weight of weights) {
    total += weight;
  }

  if (total <= 0) {
    return undefined;
  }

  let cursor = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    cursor -= weights[index];
    if (cursor <= 0) {
      return items[index];
    }
  }

  return items[items.length - 1];
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Handles signal propagation in the neural graph with LIF-like pulses and replay events.
 * Supports: 
 * - Real-time neural simulation (pulses decay and propagate along pathways)
 * - Theta-gamma replay events (hippocampal flashes + neocortical gamma pulses)
 * - Emergent actions (attentional blink, fear conditioning, memory reconsolidation)
 */
export class SignalSimulation {
  private graph: NeuralGraph;
  private actionId: BrainActionId;
  private running = true;
  private speed = 1;
  private maxPulses = DEFAULT_MAX_PULSES;
  private nextPulseId = 1;
  private spawnAccumulator = 0;
  private readonly random = mulberry32(381);
  private readonly eligiblePathways: SynapticPathway[] = [];
  private readonly eligibleWeights: number[] = [];
  // Precomputed in rebuildEligiblePathways() (on construct/setAction/reset) so
  // step() never allocates a Set or runs indexOf per frame.
  private activeRegionSet: Set<BrainRegionId> = new Set();
  private readonly activeRegionIndices: number[] = [];
  private readonly actionColors: Record<BrainActionId, string> = {
    "attentional-blink": "#a0d8f3",
    "eureka-moment": "#e7b3ff",
    "fear-conditioning": "#ff6b6b",
    "memory-reconsolidation": "#ffd700",
    "decision-hesitation": "#ffff99",
    "sensory-gating": "#6bcaff",
    "sleep-ripple": "#ffffff",
    // Default colors for base actions
    "lift-hand": "#cccccc",
    "see-object": "#aaddff",
    "hear-sound": "#ffccaa",
    "remember-event": "#ffdd88",
    "fear-response": "#ff8888",
    "speak": "#aaffaa",
    "read-text": "#ddaaff"
  };

  readonly pulses: SignalPulse[] = [];
  readonly regionIntensity: Float32Array;
  // Secondary intensity channel used for transient "flash" effects (e.g. when
  // the AI explicitly picks an action). Decays separately from regionIntensity
  // so the visual feels like a momentary burst on top of steady-state activity.
  readonly regionFlashIntensity: Float32Array;
  readonly pathwayIntensity: Float32Array;
  private _memoryIntensity = 0;
  get memoryIntensity(): number {
    return this._memoryIntensity;
  }

  // BrainSimulation optional extension properties (not modelled by SignalSimulation).
  // Always undefined/defaults — SpikingEngine provides the real values.
  readonly membranePotentialNorm: Float32Array | undefined = undefined;
  readonly dopamine = 0.3;
  readonly acetylcholine = 0.4;
  readonly thetaPhase = STUB_THETA_PHASE;
  readonly gammaPhase = STUB_GAMMA_PHASE;

  constructor(graph: NeuralGraph, actionId: BrainActionId) {
    this.graph = graph;
    this.actionId = actionId;
    this.regionIntensity = new Float32Array(graph.regionOrder.length);
    this.regionFlashIntensity = new Float32Array(graph.regionOrder.length);
    this.pathwayIntensity = new Float32Array(graph.pathways.length);
    this.rebuildEligiblePathways();
    this.initializeEmergentAction();
  }

  /**
   * Handle replay events from consolidation (theta-gamma replay).
   * - Hippocampus theta peaks: broad flashes
   * - Neocortex theta troughs: sharp gamma pulses along pathways
   */
  handleReplayEvent(event: ReplayEvent): void {
    const { memoryIds, region, thetaPhase } = event;
    if (region === "hippocampus" && thetaPhase === "peak") {
      // Theta peak: hippocampal flash
      const hippoLIndex = this.graph.regionOrder.indexOf("hippocampus-l");
      const hippoRIndex = this.graph.regionOrder.indexOf("hippocampus-r");
      const intensity = 0.7;
      if (hippoLIndex >= 0) this.regionIntensity[hippoLIndex] = Math.max(this.regionIntensity[hippoLIndex], intensity);
      if (hippoRIndex >= 0) this.regionIntensity[hippoRIndex] = Math.max(this.regionIntensity[hippoRIndex], intensity);
      this.flashRegions(["hippocampus-l", "hippocampus-r"], intensity);
    } else if (region === "neocortex" && thetaPhase === "trough") {
      // Theta trough: neocortical gamma pulses
      for (const id of memoryIds) {
        this.spawnReplayPulse(id);
      }
    }
  }

  /**
   * Spawn a gamma replay pulse along the primary pathway for a memory.
   * Uses blue-ish color to distinguish from regular pulses.
   */
  private spawnReplayPulse(memoryId: string): void {
    if (this.pulses.length >= this.maxPulses || this.eligiblePathways.length === 0) return;

    // In a real implementation, store memoryId → pathway mapping.
    // For now, pick a random eligible pathway.
    const pathway = weightedPick(this.eligiblePathways, this.eligibleWeights, this.random);
    if (!pathway) return;

    const replayColor = `hsl(220, 90%, ${50 + Math.floor(this.random() * 30)}%)`; // Blue-ish (seeded for determinism)
    this.pulses.push({
      id: this.nextPulseId++,
      pathwayIndex: pathway.id,
      fromNode: pathway.source,
      toNode: pathway.target,
      progress: 0,
      velocity: 1.3, // Faster for gamma
      intensity: 0.9, // Brighter for replay
      colorRegionId: pathway.sourceRegionId,
      colorRegionIndex: pathway.sourceRegionIndex,
      reverse: false,
      actionColor: replayColor,
    });
  }

  setGraph(graph: NeuralGraph): void {
    this.graph = graph;
    this.pulses.length = 0;
    this.spawnAccumulator = 0;
    this.nextPulseId = 1;
    this.pathwayIntensity.fill(0);
    this.rebuildEligiblePathways();
  }

  // Stamp a momentary boost onto the flash channel for each named region.
  // max-merges with the current flash so successive picks don't dim each other.
  flashRegions(regionIds: BrainRegionId[], magnitude = 0.85): void {
    for (const regionId of regionIds) {
      const index = this.graph.regionOrder.indexOf(regionId);
      if (index < 0) {
        continue;
      }
      if (this.regionFlashIntensity[index] < magnitude) {
        this.regionFlashIntensity[index] = magnitude;
      }
    }
  }

  // Pipeline events name a logical cortex (e.g. "memory-core"); fan it out to
  // the anatomical regions that cortex covers.
  flashLogicalRegion(id: LogicalRegionId, magnitude = 0.85): void {
    const regions = LOGICAL_REGION_MAP[id];
    if (regions) {
      this.flashRegions(regions, magnitude);
    }
  }

  setAction(actionId: BrainActionId): void {
    if (this.actionId === actionId) {
      return;
    }

    this.actionId = actionId;
    this.pulses.length = 0;
    this.spawnAccumulator = 0;
    this.regionIntensity.fill(0);
    this.pathwayIntensity.fill(0);
    this.rebuildEligiblePathways();
    this.initializeEmergentAction();
  }
  
  private initializeEmergentAction(): void {
    switch (this.actionId) {
      case "attentional-blink":
        emergentActions.initAttentionalBlink(this);
        break;
      case "eureka-moment":
        emergentActions.initEurekaMoment(this);
        break;
      case "fear-conditioning":
        emergentActions.initFearConditioning(this);
        break;
      case "memory-reconsolidation":
        emergentActions.initMemoryReconsolidation(this);
        break;
      case "decision-hesitation":
        emergentActions.initDecisionHesitation(this);
        break;
      case "sensory-gating":
        emergentActions.initSensoryGating(this);
        break;
      case "sleep-ripple":
        emergentActions.initSleepRipple(this);
        break;
    }
  }
  
  getActionColor(): string {
    return this.actionColors[this.actionId] || "#cccccc";
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  // Performance presets shrink the active pulse pool on lighter tiers so the
  // step loop stays cheap. Existing pulses are left to expire naturally.
  setMaxPulses(maxPulses: number): void {
    this.maxPulses = Math.max(20, Math.round(maxPulses));
  }

  setMemoryIntensity(count: number): void {
    this._memoryIntensity = Math.min(1, count / 500);
  }

  step(deltaSeconds: number, elapsedSeconds: number): void {
    const decay = Math.pow(0.05, deltaSeconds);
    const flashDecay = Math.pow(0.18, deltaSeconds);
    for (let index = 0; index < this.regionIntensity.length; index += 1) {
      this.regionIntensity[index] *= decay;
      this.regionFlashIntensity[index] *= flashDecay;
    }

    for (let index = 0; index < this.pathwayIntensity.length; index += 1) {
      this.pathwayIntensity[index] *= Math.pow(0.08, deltaSeconds);
    }

    this._memoryIntensity *= Math.pow(0.92, deltaSeconds);

    const action = ACTION_BY_ID[this.actionId];

    if (this.running) {
      for (const regionIndex of this.activeRegionIndices) {
        this.regionIntensity[regionIndex] = Math.max(
          this.regionIntensity[regionIndex],
          0.28 + Math.sin(elapsedSeconds * 4.5 + regionIndex) * 0.09,
        );
      }
    }

    if (this.memoryIntensity > 0.005) {
      const hippoL = REGION_INDEX["hippocampus-l"];
      const hippoR = REGION_INDEX["hippocampus-r"];
      if (hippoL !== undefined) {
        this.regionIntensity[hippoL] = Math.max(this.regionIntensity[hippoL], this.memoryIntensity * 0.72);
      }
      if (hippoR !== undefined) {
        this.regionIntensity[hippoR] = Math.max(this.regionIntensity[hippoR], this.memoryIntensity * 0.72);
      }
    }

    if (!this.running) {
      return;
    }

    this.spawnAccumulator += deltaSeconds * action.impulseRate * this.speed;
    while (this.spawnAccumulator >= 1) {
      this.spawnPulse(this.activeRegionSet);
      this.spawnAccumulator -= 1;
    }

    for (let index = this.pulses.length - 1; index >= 0; index -= 1) {
      const pulse = this.pulses[index];
      pulse.progress += deltaSeconds * pulse.velocity * this.speed;

      const pathway = this.graph.pathways[pulse.pathwayIndex];
      this.pathwayIntensity[pulse.pathwayIndex] = Math.max(
        this.pathwayIntensity[pulse.pathwayIndex],
        pulse.intensity * (0.35 + Math.sin(Math.min(1, pulse.progress) * Math.PI) * 0.65),
      );
      this.regionIntensity[pathway.sourceRegionIndex] = Math.max(
        this.regionIntensity[pathway.sourceRegionIndex],
        pulse.intensity * 0.52,
      );
      this.regionIntensity[pathway.targetRegionIndex] = Math.max(
        this.regionIntensity[pathway.targetRegionIndex],
        pulse.intensity * 0.52,
      );

      if (pulse.progress >= 1) {
        const targetNode = this.graph.nodes[pulse.toNode];
        this.regionIntensity[targetNode.regionIndex] = Math.max(
          this.regionIntensity[targetNode.regionIndex],
          pulse.intensity,
        );
        const last = this.pulses.pop()!;
        if (index < this.pulses.length) {
          this.pulses[index] = last;
        }
      }
    }
  }

  private rebuildEligiblePathways(): void {
    this.eligiblePathways.length = 0;
    this.eligibleWeights.length = 0;

    const action = ACTION_BY_ID[this.actionId];
    this.activeRegionSet = new Set(action.activeRegions);
    const activeRegionSet = this.activeRegionSet;
    // Resolve the active-region buffer indices once (same lookup step() used to
    // run every frame). regionIntensity is indexed by graph.regionOrder.
    this.activeRegionIndices.length = 0;
    for (const regionId of action.activeRegions) {
      const idx = this.graph.regionOrder.indexOf(regionId);
      if (idx >= 0) this.activeRegionIndices.push(idx);
    }

    for (const pathway of this.graph.pathways) {
      const sourceActive = activeRegionSet.has(pathway.sourceRegionId);
      const targetActive = activeRegionSet.has(pathway.targetRegionId);

      if (!sourceActive && !targetActive) {
        continue;
      }

      const activeWeight = sourceActive && targetActive ? 6.2 : 2.1;
      const longRangeWeight = pathway.sourceRegionId === pathway.targetRegionId ? 1 : 1.55;
      this.eligiblePathways.push(pathway);
      this.eligibleWeights.push(activeWeight * longRangeWeight * pathway.strength);
    }
  }

  private spawnPulse(activeRegionSet: Set<BrainRegionId>): void {
    if (this.pulses.length >= this.maxPulses || this.eligiblePathways.length === 0) {
      return;
    }

    const pathway = weightedPick(this.eligiblePathways, this.eligibleWeights, this.random);
    if (!pathway) {
      return;
    }

    const sourceActive = activeRegionSet.has(pathway.sourceRegionId);
    const targetActive = activeRegionSet.has(pathway.targetRegionId);
    const reverse = !sourceActive && targetActive;
    const fromNode = reverse ? pathway.target : pathway.source;
    const toNode = reverse ? pathway.source : pathway.target;
    const fromRegionIndex = reverse ? pathway.targetRegionIndex : pathway.sourceRegionIndex;
    const fromRegionId = reverse ? pathway.targetRegionId : pathway.sourceRegionId;

    const color = this.getActionColor();
    
    this.pulses.push({
      id: this.nextPulseId,
      pathwayIndex: pathway.id,
      fromNode,
      toNode,
      progress: 0,
      velocity: 0.58 + this.random() * 0.82,
      intensity: 0.62 + this.random() * 0.38,
      colorRegionId: fromRegionId,
      colorRegionIndex: fromRegionIndex,
      reverse,
      // Action-specific color for visualization (falls back to colorRegionId)
      actionColor: color,
    });

    this.nextPulseId += 1;
  }
}
