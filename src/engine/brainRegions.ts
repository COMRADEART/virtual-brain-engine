import { BRAIN_ACTIONS, REGION_DEFINITIONS } from "../data/regionDefinitions";
import type { BrainActionId, BrainRegionId, Hemisphere } from "./types";

// re-exported for downstream code that wants the raw lobe/hemisphere taxonomy
export type { Hemisphere };

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

// Build the anatomical connection list once at module load.
// Tuple format kept as [fromId, toId, count] to preserve the existing pathway-generator contract.
function buildConnections(): Array<[BrainRegionId, BrainRegionId, number]> {
  const seen = new Set<string>();
  const edges: Array<[BrainRegionId, BrainRegionId, number]> = [];
  const addEdge = (a: BrainRegionId, b: BrainRegionId, count: number) => {
    if (a === b || !REGION_BY_ID[a] || !REGION_BY_ID[b]) {
      return;
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    edges.push([a, b, count]);
  };

  // --- Corpus callosum: every cortical left↔right pair sharing a lobe.
  // Frontal pairs get the densest fibers (real callosum's anterior body is thickest).
  const cortical = REGION_DEFINITIONS.filter(
    (r) => r.hemisphere !== "midline" && r.lobe !== "subcortical",
  );
  const byHemiAndId = new Map<string, BrainRegionId>();
  for (const region of cortical) {
    byHemiAndId.set(`${region.hemisphere}:${region.id.replace(/-[lr]$/, "")}`, region.id);
  }
  const baseIds = new Set<string>();
  for (const region of cortical) {
    baseIds.add(region.id.replace(/-[lr]$/, ""));
  }
  for (const baseId of baseIds) {
    const left = byHemiAndId.get(`left:${baseId}`);
    const right = byHemiAndId.get(`right:${baseId}`);
    if (!left || !right) {
      continue;
    }
    const lobe = REGION_BY_ID[left].lobe;
    const count = lobe === "frontal" ? 40 : 30;
    addEdge(left, right, count);
  }

  // --- Thalamo-cortical fan: thalamus reaches every ipsilateral cortical region.
  for (const side of ["l", "r"] as const) {
    const thalamus = `thalamus-${side}` as BrainRegionId;
    const hemiName: Hemisphere = side === "l" ? "left" : "right";
    for (const region of cortical) {
      if (region.hemisphere !== hemiName) {
        continue;
      }
      addEdge(thalamus, region.id, 18);
    }
  }

  // --- Limbic loop (per hemisphere).
  for (const side of ["l", "r"] as const) {
    const hippo = `hippocampus-${side}` as BrainRegionId;
    const amy = `amygdala-${side}` as BrainRegionId;
    const pfc = `prefrontal-${side}` as BrainRegionId;
    const temp = `temporal-${side}` as BrainRegionId;
    addEdge(hippo, amy, 22);
    addEdge(amy, pfc, 18); // uncinate fasciculus
    addEdge(hippo, pfc, 16); // fornix-ish
    addEdge(hippo, temp, 24);
    addEdge(amy, "brainstem", 18);
  }

  // --- Cortico-cortical within hemisphere.
  const ipsiPairs: Array<[string, string]> = [
    ["prefrontal", "frontal"],
    ["prefrontal", "motor"],
    ["frontal", "motor"],
    ["motor", "somatosensory"],
    ["somatosensory", "parietal"],
    ["parietal", "occipital"],
    ["temporal", "auditory"],
    ["auditory", "parietal"],
    ["temporal", "occipital"],
    ["prefrontal", "temporal"], // arcuate fasciculus
    ["parietal", "temporal"],
  ];
  for (const side of ["l", "r"] as const) {
    for (const [from, to] of ipsiPairs) {
      addEdge(`${from}-${side}` as BrainRegionId, `${to}-${side}` as BrainRegionId, 14);
    }
  }

  // --- Motor / cerebellar loop.
  for (const side of ["l", "r"] as const) {
    const motor = `motor-${side}` as BrainRegionId;
    addEdge(motor, "brainstem", 18);
    addEdge("cerebellum", motor, 20);
  }
  addEdge("brainstem", "cerebellum", 28);

  // --- Basal ganglia loop (per hemisphere).
  for (const side of ["l", "r"] as const) {
    const bg = `basal-ganglia-${side}` as BrainRegionId;
    const thal = `thalamus-${side}` as BrainRegionId;
    const motor = `motor-${side}` as BrainRegionId;
    const pfc = `prefrontal-${side}` as BrainRegionId;
    addEdge(bg, thal, 20);
    addEdge(bg, motor, 16);
    addEdge(bg, pfc, 14);
  }

  return edges;
}

export const REGION_CONNECTIONS: Array<[BrainRegionId, BrainRegionId, number]> = buildConnections();
