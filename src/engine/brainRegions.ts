import { BRAIN_ACTIONS, REGION_DEFINITIONS } from "../data/regionDefinitions";
import type { BrainActionId, BrainRegionId } from "./types";

export const REGION_ORDER = REGION_DEFINITIONS.map((region) => region.id);

export const REGION_INDEX = REGION_ORDER.reduce(
  (accumulator, regionId, index) => {
    accumulator[regionId] = index;
    return accumulator;
  },
  {} as Record<BrainRegionId, number>,
);

export const REGION_BY_ID = REGION_DEFINITIONS.reduce(
  (accumulator, region) => {
    accumulator[region.id] = region;
    return accumulator;
  },
  {} as Record<BrainRegionId, (typeof REGION_DEFINITIONS)[number]>,
);

export const ACTION_BY_ID = BRAIN_ACTIONS.reduce(
  (accumulator, action) => {
    accumulator[action.id] = action;
    return accumulator;
  },
  {} as Record<BrainActionId, (typeof BRAIN_ACTIONS)[number]>,
);

export const REGION_CONNECTIONS: Array<[BrainRegionId, BrainRegionId, number]> = [
  ["prefrontal", "motor", 30],
  ["prefrontal", "visual", 26],
  ["prefrontal", "hippocampus", 28],
  ["prefrontal", "amygdala", 22],
  ["motor", "cerebellum", 34],
  ["motor", "brainstem", 20],
  ["visual", "hippocampus", 22],
  ["visual", "amygdala", 16],
  ["auditory", "hippocampus", 28],
  ["auditory", "amygdala", 18],
  ["hippocampus", "amygdala", 20],
  ["amygdala", "brainstem", 30],
  ["brainstem", "cerebellum", 24],
];
