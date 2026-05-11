import { REGION_CONNECTIONS, REGION_INDEX } from "./brainRegions";
import { REGION_DEFINITIONS } from "../data/regionDefinitions";
import type {
  BrainRegionId,
  NeuralGraph,
  NeuronNode,
  RegionNodeRange,
  SynapticPathway,
  Vector3Tuple,
} from "./types";

interface GenerateOptions {
  density: number;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInEllipsoid(
  random: () => number,
  center: Vector3Tuple,
  radius: Vector3Tuple,
): Vector3Tuple {
  let x = 0;
  let y = 0;
  let z = 0;
  let attempts = 0;

  do {
    x = random() * 2 - 1;
    y = random() * 2 - 1;
    z = random() * 2 - 1;
    attempts += 1;
  } while (x * x + y * y + z * z > 1 && attempts < 16);

  // A slight bilateral bias gives the generated brain two readable hemispheres.
  const hemisphere = random() > 0.5 ? 1 : -1;
  x = x * 0.72 + hemisphere * Math.abs(x) * 0.28;

  const foldNoise =
    Math.sin((center[2] + z) * 6.1 + x * 2.3) * 0.025 +
    Math.cos((center[1] + y) * 7.3 + z * 3.1) * 0.018;

  return [
    center[0] + x * radius[0] + foldNoise,
    center[1] + y * radius[1],
    center[2] + z * radius[2] + foldNoise * 0.5,
  ];
}

function distance(a: Vector3Tuple, b: Vector3Tuple): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function createPathway(
  id: number,
  source: number,
  target: number,
  nodes: NeuronNode[],
  strength: number,
): SynapticPathway {
  const sourceNode = nodes[source];
  const targetNode = nodes[target];

  return {
    id,
    source,
    target,
    sourceRegionId: sourceNode.regionId,
    targetRegionId: targetNode.regionId,
    sourceRegionIndex: sourceNode.regionIndex,
    targetRegionIndex: targetNode.regionIndex,
    strength,
    length: distance(sourceNode.position, targetNode.position),
  };
}

function pickNodeInRange(random: () => number, range: RegionNodeRange): number {
  return range.start + Math.floor(random() * range.count);
}

export function getEstimatedNeuronCount(density: number): number {
  return REGION_DEFINITIONS.reduce(
    (total, region) => total + Math.max(24, Math.round(region.baseNeuronCount * density)),
    0,
  );
}

export function generateNeuralGraph({ density, seed = 7 }: GenerateOptions): NeuralGraph {
  const random = mulberry32(seed);
  const nodes: NeuronNode[] = [];
  const pathways: SynapticPathway[] = [];
  const regionRanges = {} as Record<BrainRegionId, RegionNodeRange>;
  const regionOrder = REGION_DEFINITIONS.map((region) => region.id);

  for (const region of REGION_DEFINITIONS) {
    const start = nodes.length;
    const count = Math.max(24, Math.round(region.baseNeuronCount * density));
    const regionIndex = REGION_INDEX[region.id];

    for (let index = 0; index < count; index += 1) {
      nodes.push({
        id: nodes.length,
        regionId: region.id,
        regionIndex,
        position: randomInEllipsoid(random, region.center, region.radius),
        size: 0.012 + random() * 0.018,
      });
    }

    regionRanges[region.id] = {
      regionId: region.id,
      regionIndex,
      start,
      count,
    };
  }

  let pathwayId = 0;
  const usedEdges = new Set<string>();

  const addPathway = (source: number, target: number, strength: number) => {
    if (source === target) {
      return;
    }

    const key = source < target ? `${source}:${target}` : `${target}:${source}`;
    if (usedEdges.has(key)) {
      return;
    }

    usedEdges.add(key);
    pathways.push(createPathway(pathwayId, source, target, nodes, strength));
    pathwayId += 1;
  };

  for (const region of REGION_DEFINITIONS) {
    const range = regionRanges[region.id];
    const internalDegree = Math.max(3, Math.round(4.2 * Math.sqrt(density)));

    for (let offset = 0; offset < range.count; offset += 1) {
      const source = range.start + offset;

      for (let edge = 0; edge < internalDegree; edge += 1) {
        // Locality without an O(n^2) nearest-neighbor pass: sample from a sliding
        // neighborhood in the region's node range and jitter the target.
        const window = Math.max(12, Math.floor(range.count * 0.14));
        const signedOffset = Math.floor((random() * 2 - 1) * window);
        const randomOffset = Math.floor(random() * range.count);
        const targetOffset =
          edge % 2 === 0
            ? (offset + signedOffset + range.count) % range.count
            : randomOffset;
        const target = range.start + targetOffset;
        addPathway(source, target, 0.55 + random() * 0.45);
      }
    }
  }

  for (const [sourceRegion, targetRegion, baseCount] of REGION_CONNECTIONS) {
    const sourceRange = regionRanges[sourceRegion];
    const targetRange = regionRanges[targetRegion];
    const externalCount = Math.max(8, Math.round(baseCount * Math.sqrt(density)));

    for (let index = 0; index < externalCount; index += 1) {
      addPathway(
        pickNodeInRange(random, sourceRange),
        pickNodeInRange(random, targetRange),
        0.75 + random() * 0.65,
      );
    }
  }

  const nodePositions = new Float32Array(nodes.length * 3);
  nodes.forEach((node, index) => {
    nodePositions[index * 3] = node.position[0];
    nodePositions[index * 3 + 1] = node.position[1];
    nodePositions[index * 3 + 2] = node.position[2];
  });

  return {
    nodes,
    pathways,
    regionRanges,
    regionOrder,
    nodePositions,
  };
}
