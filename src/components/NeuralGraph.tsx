import * as THREE from "three";
import { REGION_BY_ID, REGION_INDEX } from "../engine/brainRegions";
import { PATHWAY_SEGMENTS, samplePathway } from "../engine/neuralGraphGenerator";
import type {
  BrainRegionId,
  BrainSimulation,
  NeuralGraph,
  RegionVisibility,
  SignalPulse,
} from "../engine/types";
import { getActionColor } from "../data/regionDefinitions";
import { PerformanceManager } from "../engine/PerformanceManager";

const INVISIBLE_SCALE = new THREE.Vector3(0, 0, 0);
const IDENTITY_QUATERNION = new THREE.Quaternion();
const FLOATS_PER_PATHWAY = PATHWAY_SEGMENTS * 2 * 3; // segments × (start + end) × xyz

// Phase 4 (improvement plan §1B): when colorMode is "shader" the neuron mesh's
// material is swapped to BrainVisualEffects's ShaderMaterial which reads its
// own per-instance attributes (membraneNorm/neuronType/burstStatus/memoryTrace)
// for color, and a new `aScale` per-instance float for visibility/LOD scaling.
// That lets us SKIP the two heaviest per-frame writes — `updateNeuronColors`
// (N×3 color floats) and `updateNeuronMatricesLOD` (N×16 matrix floats) — and
// only touch the N-length `aScale` array, which is the 20k-neuron unlock.
export type NeuralGraphColorMode = "legacy" | "shader";

export interface NeuralGraphRendererOptions {
  colorMode?: NeuralGraphColorMode;
}

export class NeuralGraphRenderer {
  readonly group = new THREE.Group();
  readonly regionMeshes: THREE.Mesh[] = [];

  // Public for BrainVisualEffects material swap
  readonly neuronMesh: THREE.InstancedMesh;
  readonly pathwayLines: THREE.LineSegments;
  readonly colorMode: NeuralGraphColorMode;

  private readonly graph: NeuralGraph;
  private readonly pulseMesh: THREE.InstancedMesh;
  private readonly lineColors: Float32Array;
  private readonly baseRegionColors: THREE.Color[];
  private readonly signalRegionColors: THREE.Color[];
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  // aScale: per-instance multiplier in shader mode (visibility * LOD). Length N,
  // initialised to 1.0; written when visibility toggles or LOD recomputes.
  private aScaleArr: Float32Array | null = null;
  private aScaleAttr: THREE.InstancedBufferAttribute | null = null;
  // Reused constants/scratch for the per-frame update loops — hoisted out so the
  // hot paths (region/neuron color + LOD) don't allocate a Color/Vector3 per
  // element per frame (GC churn at 60 Hz with thousands of neurons).
  private readonly white = new THREE.Color("#ffffff");
  private readonly black = new THREE.Color("#000000");
  private readonly lodScratch = new THREE.Vector3();
  private readonly pulseScale = new THREE.Vector3();
  private readonly regionMaterials = new Map<BrainRegionId, THREE.MeshBasicMaterial>();
  private readonly pulseSamplePosition = new THREE.Vector3();
  private readonly pulseScratch: [number, number, number] = [0, 0, 0];
  private performanceManager: PerformanceManager | null = null;

  constructor(
    graph: NeuralGraph,
    performanceManager: PerformanceManager | null = null,
    opts: NeuralGraphRendererOptions = {},
  ) {
    this.graph = graph;
    this.performanceManager = performanceManager;
    this.colorMode = opts.colorMode ?? "legacy";
    this.group.name = "NeuralGraph";
    this.baseRegionColors = graph.regionOrder.map((regionId) => new THREE.Color(REGION_BY_ID[regionId].color));
    this.signalRegionColors = this.baseRegionColors.map((color) => color.clone().lerp(new THREE.Color("#ffffff"), 0.36));

    this.neuronMesh = this.createNeuronMesh();
    this.pathwayLines = this.createPathwayLines();
    this.pulseMesh = this.createPulseMesh();
    this.lineColors = this.pathwayLines.geometry.getAttribute("color").array as Float32Array;

    this.group.add(this.createRegionVolumes());
    this.group.add(this.pathwayLines);
    this.group.add(this.neuronMesh);
    this.group.add(this.pulseMesh);
  }

  applyRegionVisibility(visibility: RegionVisibility): void {
    for (const regionMesh of this.regionMeshes) {
      const regionId = regionMesh.userData.regionId as BrainRegionId;
      regionMesh.visible = visibility[regionId];
    }

    // Shader mode: write to aScale (single float per neuron). Matrix already
    // encodes the base node.size from createNeuronMesh; aScale carries 0 (hide)
    // or 1 (show) without touching the 16-float per-instance matrix.
    if (this.colorMode === "shader" && this.aScaleArr && this.aScaleAttr) {
      for (let index = 0; index < this.graph.nodes.length; index += 1) {
        const node = this.graph.nodes[index];
        this.aScaleArr[index] = visibility[node.regionId] ? 1 : 0;
      }
      this.aScaleAttr.needsUpdate = true;
      return;
    }

    for (let index = 0; index < this.graph.nodes.length; index += 1) {
      const node = this.graph.nodes[index];
      const visible = visibility[node.regionId];
      this.writeNeuronMatrix(index, visible ? 1 : 0, 1); // lodScale=1 for base visibility
    }

    this.neuronMesh.instanceMatrix.needsUpdate = true;
  }

  update(
    simulation: BrainSimulation,
    visibility: RegionVisibility,
    selectedRegionId: BrainRegionId | null,
    elapsedSeconds: number,
  ): void {
    this.updateRegionVolumes(
      simulation,
      simulation.regionIntensity,
      simulation.regionFlashIntensity,
      visibility,
      selectedRegionId,
      elapsedSeconds,
    );
    // Shader mode short-circuit: BrainVisualEffects's neuron material renders
    // colors from its own per-instance attributes (membraneNorm/neuronType/etc),
    // so the two heaviest legacy per-frame writes (neuron color buffer rewrites
    // and neuron matrix LOD rewrites) are skipped. Only the much smaller aScale
    // attribute is touched — see updateAScaleLOD.
    if (this.colorMode === "shader") {
      this.updateAScaleLOD(visibility);
    } else {
      this.updateNeuronColors(simulation.regionIntensity, simulation.regionFlashIntensity, visibility);
      this.updateNeuronMatricesLOD(visibility);
    }
    this.updatePathwayColors(simulation.pathwayIntensity, visibility);
    this.updatePulses(simulation.pulses, visibility);
  }

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }

      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose());
      } else if (material) {
        material.dispose();
      }
    });
  }

  private createNeuronMesh(): THREE.InstancedMesh {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      transparent: true,
      opacity: 0.93,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, this.graph.nodes.length);
    mesh.name = "Instanced neuron nodes";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let index = 0; index < this.graph.nodes.length; index += 1) {
      const node = this.graph.nodes[index];
      const position = node.position;
      const scaleValue = node.size;
      this.matrix.compose(
        new THREE.Vector3(position[0], position[1], position[2]),
        IDENTITY_QUATERNION,
        this.pulseScale.set(scaleValue, scaleValue, scaleValue),
      );
      mesh.setMatrixAt(index, this.matrix);
      mesh.setColorAt(index, this.baseRegionColors[node.regionIndex]);
    }

    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = 4;

    // Shader mode: attach a per-instance aScale float. BrainVisualEffects's
    // NEURON_VERT multiplies position by this so visibility/LOD becomes one
    // Float32Array write per change instead of N matrix writes per frame.
    if (this.colorMode === "shader") {
      const n = this.graph.nodes.length;
      this.aScaleArr = new Float32Array(n);
      this.aScaleArr.fill(1);
      this.aScaleAttr = new THREE.InstancedBufferAttribute(this.aScaleArr, 1).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("aScale", this.aScaleAttr);
    }
    return mesh;
  }

  private createPathwayLines(): THREE.LineSegments {
    const pathwayCount = this.graph.pathways.length;
    const positions = new Float32Array(pathwayCount * FLOATS_PER_PATHWAY);
    const colors = new Float32Array(pathwayCount * FLOATS_PER_PATHWAY);

    for (let index = 0; index < pathwayCount; index += 1) {
      const pathway = this.graph.pathways[index];
      const samples = pathway.samples;
      const baseOffset = index * FLOATS_PER_PATHWAY;
      const sourceColor = this.baseRegionColors[pathway.sourceRegionIndex];
      const targetColor = this.baseRegionColors[pathway.targetRegionIndex];

      for (let segment = 0; segment < PATHWAY_SEGMENTS; segment += 1) {
        const segOffset = baseOffset + segment * 6;
        const sampleStart = segment * 3;
        const sampleEnd = (segment + 1) * 3;
        positions[segOffset] = samples[sampleStart];
        positions[segOffset + 1] = samples[sampleStart + 1];
        positions[segOffset + 2] = samples[sampleStart + 2];
        positions[segOffset + 3] = samples[sampleEnd];
        positions[segOffset + 4] = samples[sampleEnd + 1];
        positions[segOffset + 5] = samples[sampleEnd + 2];

        // Interpolate per-vertex color along the curve.
        const tStart = segment / PATHWAY_SEGMENTS;
        const tEnd = (segment + 1) / PATHWAY_SEGMENTS;
        colors[segOffset] = lerp(sourceColor.r, targetColor.r, tStart) * 0.24;
        colors[segOffset + 1] = lerp(sourceColor.g, targetColor.g, tStart) * 0.24;
        colors[segOffset + 2] = lerp(sourceColor.b, targetColor.b, tStart) * 0.24;
        colors[segOffset + 3] = lerp(sourceColor.r, targetColor.r, tEnd) * 0.24;
        colors[segOffset + 4] = lerp(sourceColor.g, targetColor.g, tEnd) * 0.24;
        colors[segOffset + 5] = lerp(sourceColor.b, targetColor.b, tEnd) * 0.24;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const lines = new THREE.LineSegments(geometry, material);
    lines.name = "Buffer geometry synaptic pathways";
    lines.renderOrder = 3;
    return lines;
  }

  private createPulseMesh(): THREE.InstancedMesh {
    const geometry = new THREE.SphereGeometry(1, 10, 8);
    const material = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      transparent: true,
      opacity: 0.95,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, 260);
    mesh.name = "Instanced electrical signal pulses";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let index = 0; index < 260; index += 1) {
      this.matrix.compose(new THREE.Vector3(0, 0, 0), IDENTITY_QUATERNION, INVISIBLE_SCALE);
      mesh.setMatrixAt(index, this.matrix);
      mesh.setColorAt(index, new THREE.Color("#ffffff"));
    }

    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = 5;
    return mesh;
  }

  private createRegionVolumes(): THREE.Group {
    const group = new THREE.Group();
    group.name = "Clickable brain regions";

    for (const regionId of this.graph.regionOrder) {
      const region = REGION_BY_ID[regionId];
      const material = new THREE.MeshBasicMaterial({
        color: region.color,
        transparent: true,
        opacity: 0.09,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 18), material);
      mesh.name = region.name;
      mesh.position.set(region.center[0], region.center[1], region.center[2]);
      mesh.scale.set(region.radius[0], region.radius[1], region.radius[2]);
      mesh.userData.regionId = regionId;
      mesh.renderOrder = 2;
      this.regionMeshes.push(mesh);
      this.regionMaterials.set(regionId, material);
      group.add(mesh);
    }

    return group;
  }

  private writeNeuronMatrix(index: number, visibilityScale: number, lodScale: number = 1): void {
    const node = this.graph.nodes[index];
    const position = node.position;
    const scaleValue = node.size * visibilityScale * lodScale;
    const scale = visibilityScale > 0 ? this.pulseScale.set(scaleValue, scaleValue, scaleValue) : INVISIBLE_SCALE;
    this.matrix.compose(
      new THREE.Vector3(position[0], position[1], position[2]),
      IDENTITY_QUATERNION,
      scale,
    );
    this.neuronMesh.setMatrixAt(index, this.matrix);
  }

  private updateRegionVolumes(
    simulation: BrainSimulation,
    regionIntensity: Float32Array,
    regionFlashIntensity: Float32Array,
    visibility: RegionVisibility,
    selectedRegionId: BrainRegionId | null,
    elapsedSeconds: number,
  ): void {
    for (const regionMesh of this.regionMeshes) {
      const regionId = regionMesh.userData.regionId as BrainRegionId;
      const region = REGION_BY_ID[regionId];
      const regionIndex = REGION_INDEX[regionId];
      const baseIntensity = regionIntensity[regionIndex] ?? 0;
      const flash = regionFlashIntensity[regionIndex] ?? 0;
      const isHippocampus = regionId === "hippocampus-l" || regionId === "hippocampus-r";
      const memoryGlow = isHippocampus ? simulation.memoryIntensity * 0.55 : 0;
      const intensity = Math.min(1, baseIntensity + flash * 1.1 + memoryGlow);
      const selected = selectedRegionId === regionId;
      const material = this.regionMaterials.get(regionId);

      if (!material) {
        continue;
      }

      regionMesh.visible = visibility[regionId];
      material.opacity = selected ? 0.28 : 0.08 + intensity * 0.17 + flash * 0.12;
      material.color.set(region.color).lerp(this.white, Math.min(0.6, intensity * 0.45));

      const pulse = selected ? Math.sin(elapsedSeconds * 4) * 0.025 : 0;
      const flashScale = 1 + flash * 0.08;
      regionMesh.scale.set(
        region.radius[0] * (1 + pulse + intensity * 0.06) * flashScale,
        region.radius[1] * (1 + pulse + intensity * 0.06) * flashScale,
        region.radius[2] * (1 + pulse + intensity * 0.06) * flashScale,
      );
    }
  }

  private updateNeuronColors(
    regionIntensity: Float32Array,
    regionFlashIntensity: Float32Array,
    visibility: RegionVisibility,
  ): void {
    for (let index = 0; index < this.graph.nodes.length; index += 1) {
      const node = this.graph.nodes[index];
      if (!visibility[node.regionId]) {
        this.neuronMesh.setColorAt(index, this.black);
        continue;
      }

      const baseIntensity = regionIntensity[node.regionIndex] ?? 0;
      const flash = regionFlashIntensity[node.regionIndex] ?? 0;
      const intensity = Math.min(1, baseIntensity + flash * 1.1);
      this.color.copy(this.baseRegionColors[node.regionIndex]).lerp(this.signalRegionColors[node.regionIndex], intensity);
      this.neuronMesh.setColorAt(index, this.color);
    }

    if (this.neuronMesh.instanceColor) {
      this.neuronMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Shader-mode LOD: write per-instance aScale (single float per neuron) for
   * visibility × LOD. Cheap — N float writes vs the legacy path's N×16 matrix
   * writes. NEURON_VERT in BrainVisualEffects multiplies position by aScale so
   * the instanceMatrix (which encodes node.size) is left untouched per frame.
   */
  updateAScaleLOD(visibility: RegionVisibility): void {
    if (!this.aScaleArr || !this.aScaleAttr) return;
    const nodes = this.graph.nodes;
    const pm = this.performanceManager;
    if (pm) {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!visibility[node.regionId]) {
          this.aScaleArr[index] = 0;
          continue;
        }
        const lodScale = pm.getNeuronLodScale(
          pm.getNeuronLodLevel(
            this.lodScratch.set(node.position[0], node.position[1], node.position[2]),
          ),
        );
        this.aScaleArr[index] = lodScale;
      }
    } else {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        this.aScaleArr[index] = visibility[node.regionId] ? 1 : 0;
      }
    }
    this.aScaleAttr.needsUpdate = true;
  }

  /**
   * Update neuron instance matrices for LOD scaling based on distance from camera.
   * Called every frame if performanceManager is available.
   * @param visibility Current region visibility to combine with LOD
   */
  updateNeuronMatricesLOD(visibility: RegionVisibility): void {
    if (!this.performanceManager) return;

    for (let index = 0; index < this.graph.nodes.length; index += 1) {
      const node = this.graph.nodes[index];
      const visible = visibility[node.regionId];
      const lodScale = this.performanceManager.getNeuronLodScale(
        this.performanceManager.getNeuronLodLevel(
          this.lodScratch.set(node.position[0], node.position[1], node.position[2])
        )
      );
      this.writeNeuronMatrix(index, visible ? 1 : 0, lodScale);
    }

    this.neuronMesh.instanceMatrix.needsUpdate = true;
  }

  private updatePathwayColors(pathwayIntensity: Float32Array, visibility: RegionVisibility): void {
    for (let index = 0; index < this.graph.pathways.length; index += 1) {
      const pathway = this.graph.pathways[index];
      const visible = visibility[pathway.sourceRegionId] && visibility[pathway.targetRegionId];
      const baseOffset = index * FLOATS_PER_PATHWAY;

      if (!visible) {
        this.lineColors.fill(0, baseOffset, baseOffset + FLOATS_PER_PATHWAY);
        continue;
      }

      const activity = Math.min(1, pathwayIntensity[index]);
      const sourceColor = this.baseRegionColors[pathway.sourceRegionIndex];
      const targetColor = this.signalRegionColors[pathway.targetRegionIndex];

      // Apply LOD scaling for pathway intensity
      const lodIntensity = this.performanceManager
        ? this.performanceManager.getPathwayLodIntensity(
            this.performanceManager.getPathwayLodLevel(pathway, this.graph.nodes)
          )
        : 1;
      const lodActivity = activity * lodIntensity;

      const sourceStrength = 0.14 + lodActivity * 0.46;
      const targetStrength = 0.18 + lodActivity * 1.1;

      // Write per-segment colors that fade from source-tinted to target-tinted along the curve.
      for (let segment = 0; segment < PATHWAY_SEGMENTS; segment += 1) {
        const tStart = segment / PATHWAY_SEGMENTS;
        const tEnd = (segment + 1) / PATHWAY_SEGMENTS;
        const segOffset = baseOffset + segment * 6;

        const rStart = lerp(sourceColor.r * sourceStrength, targetColor.r * targetStrength, tStart);
        const gStart = lerp(sourceColor.g * sourceStrength, targetColor.g * targetStrength, tStart);
        const bStart = lerp(sourceColor.b * sourceStrength, targetColor.b * targetStrength, tStart);
        const rEnd = lerp(sourceColor.r * sourceStrength, targetColor.r * targetStrength, tEnd);
        const gEnd = lerp(sourceColor.g * sourceStrength, targetColor.g * targetStrength, tEnd);
        const bEnd = lerp(sourceColor.b * sourceStrength, targetColor.b * targetStrength, tEnd);

        this.lineColors[segOffset] = rStart;
        this.lineColors[segOffset + 1] = gStart;
        this.lineColors[segOffset + 2] = bStart;
        this.lineColors[segOffset + 3] = rEnd;
        this.lineColors[segOffset + 4] = gEnd;
        this.lineColors[segOffset + 5] = bEnd;
      }
    }

    this.pathwayLines.geometry.getAttribute("color").needsUpdate = true;
  }

  private updatePulses(pulses: readonly SignalPulse[], visibility: RegionVisibility): void {
    for (let index = 0; index < 260; index += 1) {
      const pulse = pulses[index];

      if (!pulse) {
        this.matrix.compose(this.pulseSamplePosition.set(0, 0, 0), IDENTITY_QUATERNION, INVISIBLE_SCALE);
        this.pulseMesh.setMatrixAt(index, this.matrix);
        continue;
      }

      const fromNode = this.graph.nodes[pulse.fromNode];
      const toNode = this.graph.nodes[pulse.toNode];
      if (!visibility[fromNode.regionId] || !visibility[toNode.regionId]) {
        this.matrix.compose(this.pulseSamplePosition.set(0, 0, 0), IDENTITY_QUATERNION, INVISIBLE_SCALE);
        this.pulseMesh.setMatrixAt(index, this.matrix);
        continue;
      }

      const pathway = this.graph.pathways[pulse.pathwayIndex];
      const t = pulse.reverse ? 1 - pulse.progress : pulse.progress;
      samplePathway(pathway, t, this.pulseScratch);
      this.pulseSamplePosition.set(this.pulseScratch[0], this.pulseScratch[1], this.pulseScratch[2]);

      const progressBoost = 0.7 + Math.sin(t * Math.PI) * 0.3;
      const velocityBoost = 0.8 + pulse.velocity * 0.4;
      const pulseSize = (0.024 + pulse.intensity * 0.038) * progressBoost * velocityBoost;
      this.pulseScale.set(pulseSize, pulseSize, pulseSize);

      // Apply LOD scaling for pulse size
      const lodScale = this.performanceManager
        ? this.performanceManager.getPulseLodScale(
            this.performanceManager.getPulseLodLevel(pulse, pathway, this.graph.nodes)
          )
        : 1;
      this.pulseScale.multiplyScalar(lodScale);

      this.matrix.compose(this.pulseSamplePosition, IDENTITY_QUATERNION, this.pulseScale);
      this.pulseMesh.setMatrixAt(index, this.matrix);

      const colorIntensity = 0.85 + pulse.intensity * 0.15;
      
      // Use action-specific color if available, otherwise use region color
      if (pulse.actionColor) {
        this.color.set(pulse.actionColor).multiplyScalar(colorIntensity);
      } else {
        this.color.copy(this.signalRegionColors[pulse.colorRegionIndex]).multiplyScalar(colorIntensity);
      }
      this.pulseMesh.setColorAt(index, this.color);
    }

    this.pulseMesh.instanceMatrix.needsUpdate = true;
    if (this.pulseMesh.instanceColor) {
      this.pulseMesh.instanceColor.needsUpdate = true;
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
