export type Vector3Tuple = [number, number, number];

export type Hemisphere = "left" | "right" | "midline";

export type BrainLobe =
  | "frontal"
  | "parietal"
  | "temporal"
  | "occipital"
  | "subcortical"
  | "cerebellum"
  | "brainstem";

export type BrainRegionId =
  | "prefrontal-l"
  | "prefrontal-r"
  | "frontal-l"
  | "frontal-r"
  | "motor-l"
  | "motor-r"
  | "somatosensory-l"
  | "somatosensory-r"
  | "parietal-l"
  | "parietal-r"
  | "temporal-l"
  | "temporal-r"
  | "auditory-l"
  | "auditory-r"
  | "occipital-l"
  | "occipital-r"
  | "hippocampus-l"
  | "hippocampus-r"
  | "amygdala-l"
  | "amygdala-r"
  | "thalamus-l"
  | "thalamus-r"
  | "basal-ganglia-l"
  | "basal-ganglia-r"
  | "cerebellum"
  | "brainstem";

export type BrainActionId =
| "lift-hand"
| "see-object"
| "hear-sound"
| "remember-event"
| "fear-response"
| "speak"
| "read-text"
| "attentional-blink"
| "eureka-moment"
| "fear-conditioning"
| "memory-reconsolidation"
| "decision-hesitation"
| "sensory-gating"
| "sleep-ripple";

export interface BrainRegionDefinition {
  id: BrainRegionId;
  name: string;
  shortName: string;
  function: string;
  color: string;
  center: Vector3Tuple;
  radius: Vector3Tuple;
  baseNeuronCount: number;
  hemisphere: Hemisphere;
  lobe: BrainLobe;
}

export interface BrainActionDefinition {
  id: BrainActionId;
  label: string;
  description: string;
  activeRegions: BrainRegionId[];
  impulseRate: number;
}

export interface NeuronNode {
  id: number;
  regionId: BrainRegionId;
  regionIndex: number;
  position: Vector3Tuple;
  size: number;
}

export interface SynapticPathway {
  id: number;
  source: number;
  target: number;
  sourceRegionId: BrainRegionId;
  targetRegionId: BrainRegionId;
  sourceRegionIndex: number;
  targetRegionIndex: number;
  strength: number;
  length: number;
  controlPoint: Vector3Tuple;
  samples: Float32Array;
}

export interface RegionNodeRange {
  regionId: BrainRegionId;
  regionIndex: number;
  start: number;
  count: number;
}

export interface NeuralGraph {
  nodes: NeuronNode[];
  pathways: SynapticPathway[];
  regionRanges: Record<BrainRegionId, RegionNodeRange>;
  regionOrder: BrainRegionId[];
  nodePositions: Float32Array;
}

export interface SignalPulse {
  id: number;
  pathwayIndex: number;
  fromNode: number;
  toNode: number;
  progress: number;
  velocity: number;
  intensity: number;
  colorRegionId: BrainRegionId;
  colorRegionIndex: number;
  reverse: boolean;
  actionColor?: string; // Action-specific color for visualization
}

// Structural contract that the NeuralGraph renderer reads from. Both
// SignalSimulation (scripted pulses) and SpikingEngine (LIF) satisfy this
// — the renderer doesn't care which engine is driving the values.
export interface BrainSimulation {
  readonly regionIntensity: Float32Array;
  readonly regionFlashIntensity: Float32Array;
  readonly pathwayIntensity: Float32Array;
  readonly pulses: readonly SignalPulse[];
  readonly memoryIntensity: number;
  // SpikingEngine-only: membrane potential [0,1] per neuron for heatmap viz.
  // Undefined/null when running SignalSimulation (no membrane model).
  readonly membranePotentialNorm?: Float32Array;
  // SpikingEngine-only: neuromodulator scalars [0,1].
  readonly dopamine?: number;
  readonly acetylcholine?: number;
  // SpikingEngine-only: oscillation phases in radians.
  readonly thetaPhase?: number;
  readonly gammaPhase?: number;
}

export interface BrainMetrics {
  neurons: number;
  pathways: number;
  regions: number;
  fps?: number;
  mem?: number;
}

export type RegionVisibility = Record<BrainRegionId, boolean>;

export interface CameraPresetRequest {
  mode: "overview" | "inside" | "reset";
  sequence: number;
}
