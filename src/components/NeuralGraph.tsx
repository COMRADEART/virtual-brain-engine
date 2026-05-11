import * as THREE from "three";
import { REGION_BY_ID } from "../engine/brainRegions";
import type {
  BrainRegionId,
  NeuralGraph,
  RegionVisibility,
  SignalPulse,
} from "../engine/types";
import type { SignalSimulation } from "../engine/signalSimulation";

const INVISIBLE_SCALE = new THREE.Vector3(0, 0, 0);
const IDENTITY_QUATERNION = new THREE.Quaternion();

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
  private readonly nodeVisibility = new Uint8Array(0);

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
    this.updateRegionVolumes(simulation.regionIntensity, visibility, selectedRegionId, elapsedSeconds);
    this.updateNeuronColors(simulation.regionIntensity, visibility);
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
    const positions = new Float32Array(this.graph.pathways.length * 6);
    const colors = new Float32Array(this.graph.pathways.length * 6);

    for (let index = 0; index < this.graph.pathways.length; index += 1) {
      const pathway = this.graph.pathways[index];
      const source = this.graph.nodes[pathway.source].position;
      const target = this.graph.nodes[pathway.target].position;
      positions.set(source, index * 6);
      positions.set(target, index * 6 + 3);

      const sourceColor = this.baseRegionColors[pathway.sourceRegionIndex];
      const targetColor = this.baseRegionColors[pathway.targetRegionIndex];
      colors[index * 6] = sourceColor.r * 0.24;
      colors[index * 6 + 1] = sourceColor.g * 0.24;
      colors[index * 6 + 2] = sourceColor.b * 0.24;
      colors[index * 6 + 3] = targetColor.r * 0.24;
      colors[index * 6 + 4] = targetColor.g * 0.24;
      colors[index * 6 + 5] = targetColor.b * 0.24;
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
    visibility: RegionVisibility,
    selectedRegionId: BrainRegionId | null,
    elapsedSeconds: number,
  ): void {
    for (const regionMesh of this.regionMeshes) {
      const regionId = regionMesh.userData.regionId as BrainRegionId;
      const region = REGION_BY_ID[regionId];
      const regionIndex = this.graph.regionOrder.indexOf(regionId);
      const intensity = regionIntensity[regionIndex] ?? 0;
      const selected = selectedRegionId === regionId;
      const material = this.regionMaterials.get(regionId);

      if (!material) {
        continue;
      }

      regionMesh.visible = visibility[regionId];
      material.opacity = selected ? 0.28 : 0.08 + intensity * 0.17;
      material.color.set(region.color).lerp(new THREE.Color("#ffffff"), Math.min(0.6, intensity * 0.45));

      const pulse = selected ? Math.sin(elapsedSeconds * 4) * 0.025 : 0;
      regionMesh.scale.set(
        region.radius[0] * (1 + pulse + intensity * 0.06),
        region.radius[1] * (1 + pulse + intensity * 0.06),
        region.radius[2] * (1 + pulse + intensity * 0.06),
      );
    }
  }

  private updateNeuronColors(regionIntensity: Float32Array, visibility: RegionVisibility): void {
    for (let index = 0; index < this.graph.nodes.length; index += 1) {
      const node = this.graph.nodes[index];
      if (!visibility[node.regionId]) {
        this.neuronMesh.setColorAt(index, new THREE.Color("#000000"));
        continue;
      }

      const intensity = Math.min(1, regionIntensity[node.regionIndex]);
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
      const baseOffset = index * 6;

      if (!visible) {
        this.lineColors.fill(0, baseOffset, baseOffset + 6);
        continue;
      }

      const activity = Math.min(1, pathwayIntensity[index]);
      const sourceColor = this.baseRegionColors[pathway.sourceRegionIndex];
      const targetColor = this.signalRegionColors[pathway.targetRegionIndex];
      const sourceStrength = 0.14 + activity * 0.46;
      const targetStrength = 0.18 + activity * 1.1;

      this.lineColors[baseOffset] = sourceColor.r * sourceStrength;
      this.lineColors[baseOffset + 1] = sourceColor.g * sourceStrength;
      this.lineColors[baseOffset + 2] = sourceColor.b * sourceStrength;
      this.lineColors[baseOffset + 3] = targetColor.r * targetStrength;
      this.lineColors[baseOffset + 4] = targetColor.g * targetStrength;
      this.lineColors[baseOffset + 5] = targetColor.b * targetStrength;
    }

    this.pathwayLines.geometry.getAttribute("color").needsUpdate = true;
  }

  private updatePulses(pulses: SignalPulse[], visibility: RegionVisibility): void {
    const position = new THREE.Vector3();
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();

    for (let index = 0; index < 260; index += 1) {
      const pulse = pulses[index];

      if (!pulse) {
        this.matrix.compose(position.set(0, 0, 0), IDENTITY_QUATERNION, INVISIBLE_SCALE);
        this.pulseMesh.setMatrixAt(index, this.matrix);
        continue;
      }

      const fromNode = this.graph.nodes[pulse.fromNode];
      const toNode = this.graph.nodes[pulse.toNode];
      if (!visibility[fromNode.regionId] || !visibility[toNode.regionId]) {
        this.matrix.compose(position.set(0, 0, 0), IDENTITY_QUATERNION, INVISIBLE_SCALE);
        this.pulseMesh.setMatrixAt(index, this.matrix);
        continue;
      }

      from.set(fromNode.position[0], fromNode.position[1], fromNode.position[2]);
      to.set(toNode.position[0], toNode.position[1], toNode.position[2]);
      position.lerpVectors(from, to, pulse.progress);

      const pulseSize = 0.024 + pulse.intensity * 0.038;
      this.pulseScale.set(pulseSize, pulseSize, pulseSize);
      this.matrix.compose(position, IDENTITY_QUATERNION, this.pulseScale);
      this.pulseMesh.setMatrixAt(index, this.matrix);
      this.pulseMesh.setColorAt(index, this.signalRegionColors[pulse.colorRegionIndex]);
    }

    this.pulseMesh.instanceMatrix.needsUpdate = true;
    if (this.pulseMesh.instanceColor) {
      this.pulseMesh.instanceColor.needsUpdate = true;
    }
  }
}
