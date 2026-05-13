import type { BrainRegionId } from "./types";
import type { LogicalRegionId } from "../../shared/pipeline";

// Maps an 8-cortex logical view onto the 30 anatomical regions. The pipeline
// emits LogicalRegionId in PipelineEvent.logicalRegions; BrainScene unpacks
// each one into the anatomical IDs below and flashes them.
export const LOGICAL_REGION_MAP: Record<LogicalRegionId, BrainRegionId[]> = {
  "memory-core": ["hippocampus-l", "hippocampus-r", "temporal-l", "temporal-r"],
  "reasoning-cortex": ["prefrontal-l", "prefrontal-r", "frontal-l", "frontal-r"],
  "project-cortex": ["parietal-l", "parietal-r"],
  "file-memory": ["temporal-l", "hippocampus-l"],
  "model-hub": ["thalamus-l", "thalamus-r"],
  "response-center": ["motor-l", "prefrontal-l"],
  "error-detection-center": ["prefrontal-r", "amygdala-l", "amygdala-r"],
  "learning-feedback-center": ["cerebellum", "basal-ganglia-l", "basal-ganglia-r"],
};

export const LOGICAL_REGION_LABELS: Record<LogicalRegionId, string> = {
  "memory-core": "Memory core",
  "reasoning-cortex": "Reasoning cortex",
  "project-cortex": "Project cortex",
  "file-memory": "File memory",
  "model-hub": "Model hub",
  "response-center": "Response center",
  "error-detection-center": "Error detection",
  "learning-feedback-center": "Learning feedback",
};
