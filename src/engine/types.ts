export type Vector3Tuple = [number, number, number];

export type BrainRegionId =
  | "prefrontal"
  | "motor"
  | "visual"
  | "auditory"
  | "hippocampus"
  | "amygdala"
  | "cerebellum"
  | "brainstem";

export type BrainActionId =
  | "lift-hand"
  | "see-object"
  | "hear-sound"
  | "remember-event"
  | "fear-response";

export interface BrainRegionDefinition {
  id: BrainRegionId;
  name: string;
  shortName: string;
  function: string;
  color: string;
  center: Vector3Tuple;
  radius: Vector3Tuple;
  baseNeuronCount: number;
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
}

export interface BrainMetrics {
  neurons: number;
  pathways: number;
  regions: number;
}

export type RegionVisibility = Record<BrainRegionId, boolean>;

export interface CameraPresetRequest {
  mode: "overview" | "inside" | "reset";
  sequence: number;
}
