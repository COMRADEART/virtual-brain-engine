import * as THREE from "three";
import { REGION_BY_ID } from "../engine/brainRegions";
import { PATHWAY_SEGMENTS, samplePathway } from "../engine/neuralGraphGenerator";
import type {
  BrainRegionId,
  NeuralGraph,
  RegionVisibility,
  SignalPulse,
} from "../engine/types";
import type { SignalSimulation } from "../engine/signalSimulation";

const INVISIBLE_SCALE = new THREE.Vector3(0, 0, 0);
const IDENTITY_QUATERNION = new THREE.Quaternion();
const FLOATS_PER_PATHWAY = PATHWAY_SEGMENTS * 2 * 3; // segments × (start + end) × xyz

export class NeuralGraphRenderer {
  readonly group = new THREE.Group();
  readonly regionMeshes: THREE.Mesh[] = [];

  private readonly graph: NeuralGraph;
  private readonly neuronMesh: THREE.InstancedMesh;
  private readonly pathwayLines: THREE.LineSegments;
  private readonly pulseMesh: THREE.InstancedMesh;
  private readonly lineColors: Float32Array;
  private readonly baseRegionColors: THREE.Color[];
  private readonly signalRegionColors: THREE.Color[];
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly pulseScale = new THREE.Vector3();
  private readonly regionMaterials = new Map<BrainRegionId, THREE.MeshBasicMaterial>();
  private readonly pulseSamplePosition = new THREE.Vector3();
  private readonly pulseScratch: [number, number, number] = [0, 0, 0];

  constructor(graph: NeuralGraph) {
    this.graph = graph;
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

    for (let index = 0; index < this.graph.nodes.length; index += 1) {
      const node = this.graph.nodes[index];
      const visible = visibility[node.regionId];
      this.writeNeuronMatrix(index, visible ? 1 : 0);
    }

    this.neuronMesh.instanceMatrix.needsUpdate = true;
  }

  update(
    simulation: SignalSimulation,
    visibility: RegionVisibility,
    selectedRegionId: BrainRegionId | null,
    elapsedSeconds: number,
  ): void {
    this.updateRegionVolumes(
      simulation.regionIntensity,
      simulation.regionFlashIntensity,
      visibility,
      selectedRegionId,
      elapsedSeconds,
    );
    this.updateNeuronColors(simulation.regionIntensity, simulation.regionFlashIntensity, visibility);
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

  private writeNeuronMatrix(index: number, visibilityScale: number): void {
    const node = this.graph.nodes[index];
    const position = node.position;
    const scaleValue = node.size * visibilityScale;
    const scale = visibilityScale > 0 ? this.pulseScale.set(scaleValue, scaleValue, scaleValue) : INVISIBLE_SCALE;
    this.matrix.compose(
      new THREE.Vector3(position[0], position[1], position[2]),
      IDENTITY_QUATERNION,
      scale,
    );
    this.neuronMesh.setMatrixAt(index, this.matrix);
  }

  private updateRegionVolumes(
    regionIntensity: Float32Array,
    regionFlashIntensity: Float32Array,
    visibility: RegionVisibility,
    selectedRegionId: BrainRegionId | null,
    elapsedSeconds: number,
  ): void {
    for (const regionMesh of this.regionMeshes) {
      const regionId = regionMesh.userData.regionId as BrainRegionId;
      const region = REGION_BY_ID[regionId];
      const regionIndex = this.graph.regionOrder.indexOf(regionId);
      const baseIntensity = regionIntensity[regionIndex] ?? 0;
      const flash = regionFlashIntensity[regionIndex] ?? 0;
      const intensity = Math.min(1, baseIntensity + flash * 1.1);
      const selected = selectedRegionId === regionId;
      const material = this.regionMaterials.get(regionId);

      if (!material) {
        continue;
      }

      regionMesh.visible = visibility[regionId];
      material.opacity = selected ? 0.28 : 0.08 + intensity * 0.17 + flash * 0.12;
      material.color.set(region.color).lerp(new THREE.Color("#ffffff"), Math.min(0.6, intensity * 0.45));

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
        this.neuronMesh.setColorAt(index, new THREE.Color("#000000"));
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
      const sourceStrength = 0.14 + activity * 0.46;
      const targetStrength = 0.18 + activity * 1.1;

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

  private updatePulses(pulses: SignalPulse[], visibility: RegionVisibility): void {
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

      const pulseSize = 0.024 + pulse.intensity * 0.038;
      this.pulseScale.set(pulseSize, pulseSize, pulseSize);
      this.matrix.compose(this.pulseSamplePosition, IDENTITY_QUATERNION, this.pulseScale);
      this.pulseMesh.setMatrixAt(index, this.matrix);
      this.pulseMesh.setColorAt(index, this.signalRegionColors[pulse.colorRegionIndex]);
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
