import { REGION_BY_ID, REGION_CONNECTIONS, REGION_INDEX } from "./brainRegions";
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

export const PATHWAY_SEGMENTS = 8;

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

  // A bit of folding noise so neurons cluster along sulci-like ridges.
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

// Quadratic bezier point at parameter t along (p0 → c → p1).
function bezier(
  p0: Vector3Tuple,
  c: Vector3Tuple,
  p1: Vector3Tuple,
  t: number,
): Vector3Tuple {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const d = t * t;
  return [
    p0[0] * a + c[0] * b + p1[0] * d,
    p0[1] * a + c[1] * b + p1[1] * d,
    p0[2] * a + c[2] * b + p1[2] * d,
  ];
}

// Compute a bend direction that pushes the pathway outward from the brain centroid.
// Special cases:
//   * callosal (crossing x=0 between two cortical regions): arch up over the longitudinal fissure
//   * brainstem/cerebellum endpoints: dip down into the posterior fossa instead of arching over cortex
function computeControlPoint(
  source: Vector3Tuple,
  target: Vector3Tuple,
  sourceRegionId: BrainRegionId,
  targetRegionId: BrainRegionId,
  jitter: () => number,
): Vector3Tuple {
  const mid: Vector3Tuple = [
    (source[0] + target[0]) * 0.5,
    (source[1] + target[1]) * 0.5,
    (source[2] + target[2]) * 0.5,
  ];

  const dist = distance(source, target);
  const bend = Math.max(0.15, dist * 0.32);

  // Unit vector from centroid (origin) through midpoint.
  const len = Math.sqrt(mid[0] * mid[0] + mid[1] * mid[1] + mid[2] * mid[2]) || 1;
  const outward: Vector3Tuple = [mid[0] / len, mid[1] / len, mid[2] / len];

  const sourceRegion = REGION_BY_ID[sourceRegionId];
  const targetRegion = REGION_BY_ID[targetRegionId];

  const sourceHemi = sourceRegion?.hemisphere;
  const targetHemi = targetRegion?.hemisphere;

  const isCallosal =
    sourceHemi &&
    targetHemi &&
    sourceHemi !== "midline" &&
    targetHemi !== "midline" &&
    sourceHemi !== targetHemi &&
    sourceRegion.lobe !== "subcortical" &&
    targetRegion.lobe !== "subcortical";

  const touchesPosteriorFossa =
    sourceRegion?.lobe === "cerebellum" ||
    targetRegion?.lobe === "cerebellum" ||
    sourceRegion?.lobe === "brainstem" ||
    targetRegion?.lobe === "brainstem";

  // Small seeded jitter so the bundle doesn't look like a perfect mathematical surface.
  const jx = (jitter() - 0.5) * 0.08;
  const jy = (jitter() - 0.5) * 0.08;
  const jz = (jitter() - 0.5) * 0.08;

  if (isCallosal) {
    // Arch over the top: high y, pulled back toward the midline.
    return [
      mid[0] * 0.25 + jx,
      Math.max(mid[1], 0.05) + bend * 0.9 + 0.18 + jy,
      mid[2] + jz,
    ];
  }

  if (touchesPosteriorFossa) {
    // Dip downward / backward into the posterior fossa.
    return [
      mid[0] + outward[0] * bend * 0.3 + jx,
      mid[1] - Math.abs(bend) * 0.6 - 0.05 + jy,
      mid[2] + outward[2] * bend * 0.2 - 0.15 + jz,
    ];
  }

  // Generic cortico-cortical / subcortical curve: bulge outward from centroid.
  return [
    mid[0] + outward[0] * bend + jx,
    mid[1] + outward[1] * bend + jy,
    mid[2] + outward[2] * bend + jz,
  ];
}

function sampleBezier(
  source: Vector3Tuple,
  control: Vector3Tuple,
  target: Vector3Tuple,
): { samples: Float32Array; arcLength: number } {
  const samples = new Float32Array((PATHWAY_SEGMENTS + 1) * 3);
  let arcLength = 0;
  let prev: Vector3Tuple = source;
  samples[0] = source[0];
  samples[1] = source[1];
  samples[2] = source[2];
  for (let i = 1; i <= PATHWAY_SEGMENTS; i += 1) {
    const t = i / PATHWAY_SEGMENTS;
    const point = bezier(source, control, target, t);
    samples[i * 3] = point[0];
    samples[i * 3 + 1] = point[1];
    samples[i * 3 + 2] = point[2];
    arcLength += distance(prev, point);
    prev = point;
  }
  return { samples, arcLength };
}

// Sample any pathway at parameter t ∈ [0, 1] using its pre-stored bezier samples.
// Linear interpolation between adjacent samples is good enough at 8 segments.
export function samplePathway(
  pathway: SynapticPathway,
  t: number,
  out: [number, number, number],
): void {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = clamped * PATHWAY_SEGMENTS;
  const i = Math.min(PATHWAY_SEGMENTS - 1, Math.floor(scaled));
  const f = scaled - i;
  const a = i * 3;
  const b = (i + 1) * 3;
  const samples = pathway.samples;
  out[0] = samples[a] + (samples[b] - samples[a]) * f;
  out[1] = samples[a + 1] + (samples[b + 1] - samples[a + 1]) * f;
  out[2] = samples[a + 2] + (samples[b + 2] - samples[a + 2]) * f;
}

function createPathway(
  id: number,
  source: number,
  target: number,
  nodes: NeuronNode[],
  strength: number,
  jitter: () => number,
): SynapticPathway {
  const sourceNode = nodes[source];
  const targetNode = nodes[target];

  const controlPoint = computeControlPoint(
    sourceNode.position,
    targetNode.position,
    sourceNode.regionId,
    targetNode.regionId,
    jitter,
  );
  const { samples, arcLength } = sampleBezier(
    sourceNode.position,
    controlPoint,
    targetNode.position,
  );

  return {
    id,
    source,
    target,
    sourceRegionId: sourceNode.regionId,
    targetRegionId: targetNode.regionId,
    sourceRegionIndex: sourceNode.regionIndex,
    targetRegionIndex: targetNode.regionIndex,
    strength,
    length: arcLength,
    controlPoint,
    samples,
  };
}

function pickNodeInRange(random: () => number, range: RegionNodeRange): number {
  return range.start + Math.floor(random() * range.count);
}

export function getEstimatedNeuronCount(density: number): number {
  return REGION_DEFINITIONS.reduce(
    (total, region) => total + Math.max(18, Math.round(region.baseNeuronCount * density)),
    0,
  );
}

export function generateNeuralGraph({ density, seed = 7 }: GenerateOptions): NeuralGraph {
  const random = mulberry32(seed);
  const jitter = mulberry32(seed + 91);
  const nodes: NeuronNode[] = [];
  const pathways: SynapticPathway[] = [];
  const regionRanges = {} as Record<BrainRegionId, RegionNodeRange>;
  const regionOrder = REGION_DEFINITIONS.map((region) => region.id);

  for (const region of REGION_DEFINITIONS) {
    const start = nodes.length;
    const count = Math.max(18, Math.round(region.baseNeuronCount * density));
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
    pathways.push(createPathway(pathwayId, source, target, nodes, strength, jitter));
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
    if (!sourceRange || !targetRange) {
      continue;
    }
    const externalCount = Math.max(6, Math.round(baseCount * Math.sqrt(density)));

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
