import { ACTION_BY_ID } from "./brainRegions";
import { LOGICAL_REGION_MAP } from "./logicalRegions";
import type { LogicalRegionId } from "../../shared/pipeline";
import type {
  BrainActionId,
  BrainRegionId,
  NeuralGraph,
  SignalPulse,
  SynapticPathway,
} from "./types";

const MAX_PULSES = 260;

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

export class SignalSimulation {
  private graph: NeuralGraph;
  private actionId: BrainActionId;
  private running = true;
  private speed = 1;
  private nextPulseId = 1;
  private spawnAccumulator = 0;
  private readonly random = mulberry32(381);
  private readonly eligiblePathways: SynapticPathway[] = [];
  private readonly eligibleWeights: number[] = [];

  readonly pulses: SignalPulse[] = [];
  readonly regionIntensity: Float32Array;
  // Secondary intensity channel used for transient "flash" effects (e.g. when
  // the AI explicitly picks an action). Decays separately from regionIntensity
  // so the visual feels like a momentary burst on top of steady-state activity.
  readonly regionFlashIntensity: Float32Array;
  readonly pathwayIntensity: Float32Array;

  constructor(graph: NeuralGraph, actionId: BrainActionId) {
    this.graph = graph;
    this.actionId = actionId;
    this.regionIntensity = new Float32Array(graph.regionOrder.length);
    this.regionFlashIntensity = new Float32Array(graph.regionOrder.length);
    this.pathwayIntensity = new Float32Array(graph.pathways.length);
    this.rebuildEligiblePathways();
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
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
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

    const action = ACTION_BY_ID[this.actionId];
    const activeRegionSet = new Set(action.activeRegions);

    for (const regionId of action.activeRegions) {
      const regionIndex = this.graph.regionOrder.indexOf(regionId);
      if (regionIndex >= 0 && this.running) {
        this.regionIntensity[regionIndex] = Math.max(
          this.regionIntensity[regionIndex],
          0.28 + Math.sin(elapsedSeconds * 4.5 + regionIndex) * 0.09,
        );
      }
    }

    if (!this.running) {
      return;
    }

    this.spawnAccumulator += deltaSeconds * action.impulseRate * this.speed;
    while (this.spawnAccumulator >= 1) {
      this.spawnPulse(activeRegionSet);
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
        this.pulses.splice(index, 1);
      }
    }
  }

  private rebuildEligiblePathways(): void {
    this.eligiblePathways.length = 0;
    this.eligibleWeights.length = 0;

    const action = ACTION_BY_ID[this.actionId];
    const activeRegionSet = new Set(action.activeRegions);

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
    if (this.pulses.length >= MAX_PULSES || this.eligiblePathways.length === 0) {
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
    });

    this.nextPulseId += 1;
  }
}
