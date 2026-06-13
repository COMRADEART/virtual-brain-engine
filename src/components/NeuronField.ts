import * as THREE from "three";
import { REGION_INDEX } from "../engine/brainRegions";
import { REGION_DEFINITIONS } from "../data/regionDefinitions";
import type { BrainRegionId, RegionVisibility } from "../engine/types";

// ─── The million-neuron field ───────────────────────────────────────────────
//
// The interactive NeuralGraph (NeuralGraph.tsx) renders a few thousand neurons
// as an InstancedMesh with clickable region volumes, real synaptic PATHWAYS, and
// travelling pulses. Those are the parts whose cost scales badly — pathway count
// and per-frame color/matrix rewrites — so that mesh stays bounded.
//
// This NeuronField is the cheap way to render the OTHER ~million neurons purely
// as visual density. It is a single THREE.Points cloud with a custom shader:
//
//   • Per-neuron data (position / size / region index / twinkle phase) is built
//     ONCE into typed arrays — no per-node JS objects, so a million points cost
//     ~24 MB and build in well under a frame.
//   • Color + activity are driven by SMALL per-REGION uniform arrays (≈28 floats)
//     that the vertex shader looks up by each point's region index. So the only
//     per-frame CPU work is copying simulation.regionIntensity into a uniform —
//     O(regions), NOT O(neurons). The GPU happily draws a million 1-vertex points.
//   • No pathways, no pulses, no raycast targets — those remain the interactive
//     mesh's job. This is the nebula the structured graph floats inside.
//
// It reads the SAME region-intensity buffer the NeuralGraphRenderer does, so the
// field lights up in lock-step with pipeline flashes / spiking activity.

const REGION_COUNT = REGION_DEFINITIONS.length;

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft round sprite (shared across instances). Additive-blended so overlapping
// points read as a glowing cloud rather than hard dots.
let sharedSprite: THREE.Texture | null = null;
function pointSprite(): THREE.Texture {
  if (sharedSprite) return sharedSprite;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.65)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  sharedSprite = tex;
  return tex;
}

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aRegion;
  attribute float aPhase;

  uniform vec3 uRegionColor[REGION_COUNT];
  uniform float uRegionIntensity[REGION_COUNT];
  uniform float uRegionVisible[REGION_COUNT];
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uBaseSize;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // Vertex shaders may dynamically index uniform arrays (GLSL ES 1.00 §A.4),
    // and REGION_COUNT (~28) is far under the min uniform-vector budget.
    int idx = int(aRegion + 0.5);
    vec3 base = uRegionColor[idx];
    float intensity = uRegionIntensity[idx];
    float visible = uRegionVisible[idx];

    vec3 lit = mix(base, vec3(1.0), intensity * 0.55);
    float twinkle = 0.82 + 0.18 * sin(uTime * 2.1 + aPhase * 6.2831853);
    vColor = lit * (0.42 + intensity * 1.15) * twinkle;
    vAlpha = visible * (0.30 + intensity * 0.55);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float sizeBoost = 1.0 + intensity * 1.4;
    // Perspective attenuation: nearer points are larger. Collapse to 0 when the
    // point's region is hidden so it contributes no fragments.
    gl_PointSize = visible * aSize * uBaseSize * uPixelRatio * sizeBoost / max(0.0001, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.0) discard;
    float a = texture2D(uMap, gl_PointCoord).a;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor, a * vAlpha * uOpacity);
  }
`;

export interface NeuronFieldOptions {
  count: number;
  pixelRatio: number;
  baseSize?: number;
  opacity?: number;
  seed?: number;
}

export class NeuronField {
  readonly points: THREE.Points;
  /** Actual number of points generated (may differ slightly from the request). */
  readonly count: number;

  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  // Region-id at each region index, for the per-frame visibility lookup.
  private readonly regionIds: BrainRegionId[];
  // Reused uniform array buffers — mutated in place each frame (≈28 floats).
  private readonly intensityArr: Float32Array;
  private readonly visibleArr: Float32Array;

  constructor(opts: NeuronFieldOptions) {
    const target = Math.max(0, Math.floor(opts.count));
    const seed = opts.seed ?? 1337;

    // Per-region static data, indexed by REGION_INDEX (the same index the
    // simulation's regionIntensity buffer uses).
    const colors: THREE.Vector3[] = new Array(REGION_COUNT);
    const centers: Array<[number, number, number]> = new Array(REGION_COUNT);
    const radii: Array<[number, number, number]> = new Array(REGION_COUNT);
    const weights = new Float32Array(REGION_COUNT);
    this.regionIds = new Array(REGION_COUNT);
    let weightSum = 0;
    for (const region of REGION_DEFINITIONS) {
      const idx = REGION_INDEX[region.id];
      const c = new THREE.Color(region.color);
      colors[idx] = new THREE.Vector3(c.r, c.g, c.b);
      centers[idx] = [region.center[0], region.center[1], region.center[2]];
      radii[idx] = [region.radius[0], region.radius[1], region.radius[2]];
      weights[idx] = region.baseNeuronCount;
      this.regionIds[idx] = region.id;
      weightSum += region.baseNeuronCount;
    }

    // Distribute the target population across regions in proportion to each
    // region's baseNeuronCount (so the field mirrors the brain's real density
    // gradient). Sum may differ slightly from the target — count is the truth.
    const perRegion = new Int32Array(REGION_COUNT);
    let total = 0;
    for (let i = 0; i < REGION_COUNT; i += 1) {
      const n = weightSum > 0 ? Math.round((target * weights[i]) / weightSum) : 0;
      perRegion[i] = n;
      total += n;
    }
    this.count = total;

    const positions = new Float32Array(total * 3);
    const aSize = new Float32Array(total);
    const aRegion = new Float32Array(total);
    const aPhase = new Float32Array(total);

    const rand = mulberry32(seed);
    let cursor = 0;
    for (let i = 0; i < REGION_COUNT; i += 1) {
      const n = perRegion[i];
      const [cx, cy, cz] = centers[i];
      const [rx, ry, rz] = radii[i];
      for (let k = 0; k < n; k += 1) {
        // Rejection-sample a point inside the unit sphere → scale into the
        // region's ellipsoid. Bounded attempts keep the build O(points).
        let x = 0;
        let y = 0;
        let z = 0;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          x = rand() * 2 - 1;
          y = rand() * 2 - 1;
          z = rand() * 2 - 1;
          if (x * x + y * y + z * z <= 1) break;
        }
        positions[cursor * 3] = cx + x * rx;
        positions[cursor * 3 + 1] = cy + y * ry;
        positions[cursor * 3 + 2] = cz + z * rz;
        aSize[cursor] = 0.6 + rand() * 1.4;
        aRegion[cursor] = i;
        aPhase[cursor] = rand();
        cursor += 1;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
    geometry.setAttribute("aRegion", new THREE.BufferAttribute(aRegion, 1));
    geometry.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1));
    // The cloud is scattered into the same world volume as the synthetic shell;
    // a fixed bounding sphere skips a million-point computeBoundingSphere pass
    // and prevents frustum-culling the whole cloud at the wrong moment.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 4);
    this.geometry = geometry;

    this.intensityArr = new Float32Array(REGION_COUNT);
    this.visibleArr = new Float32Array(REGION_COUNT).fill(1);

    this.material = new THREE.ShaderMaterial({
      defines: { REGION_COUNT },
      uniforms: {
        uRegionColor: { value: colors },
        uRegionIntensity: { value: this.intensityArr },
        uRegionVisible: { value: this.visibleArr },
        uTime: { value: 0 },
        uPixelRatio: { value: opts.pixelRatio },
        uBaseSize: { value: opts.baseSize ?? 2.1 },
        uMap: { value: pointSprite() },
        uOpacity: { value: opts.opacity ?? 0.85 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, this.material);
    points.name = "Neuron field (point cloud)";
    // Behind the interactive mesh + pulses, in front of the anatomy reference.
    points.renderOrder = 1;
    points.frustumCulled = false;
    this.points = points;
  }

  /** Per-frame: push region activity + visibility into the shader uniforms. */
  update(
    regionIntensity: Float32Array,
    regionFlashIntensity: Float32Array,
    visibility: RegionVisibility,
    elapsedSeconds: number,
  ): void {
    for (let i = 0; i < REGION_COUNT; i += 1) {
      const base = regionIntensity[i] ?? 0;
      const flash = regionFlashIntensity[i] ?? 0;
      this.intensityArr[i] = Math.min(1, base + flash * 1.1);
      this.visibleArr[i] = visibility[this.regionIds[i]] ? 1 : 0;
    }
    this.material.uniforms.uTime.value = elapsedSeconds;
  }

  setPixelRatio(pixelRatio: number): void {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
