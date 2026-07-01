import type { NeuronNode } from "./types";
import type { SynapticPathway } from "./types";
import type { SignalPulse } from "./types";
import * as THREE from "three";

/**
 * PerformanceManager handles adaptive performance optimization including:
 * - Frame rate monitoring and adaptive quality adjustment
 * - Distance-based Level of Detail (LOD) for neurons, pathways, and pulses
 * - Simulation optimization (pulse culling, etc.)
 * - Integration with existing adaptive quality system
 */
export class PerformanceManager {
  private readonly targetFrameTime = 16.67; // ms for 60fps
  private emaFrameTime = 16.67;
  private readonly alpha = 0.1; // EMA smoothing factor

  // LOD distance thresholds (in world units)
  private readonly lodThresholds = {
    neuron: {
      high: 2.0,   // within 2 units: full detail
      medium: 5.0, // 2-5 units: medium detail
      low: 10.0    // 5-10 units: low detail, beyond: culled
    },
    pathway: {
      high: 3.0,
      medium: 7.0,
      low: 15.0
    },
    pulse: {
      high: 2.5,
      medium: 6.0,
      low: 12.0
    }
  };

  // LOD scale factors for each level (applied to size/intensity)
  private readonly lodScales = {
    high: 1.0,
    medium: 0.6,
    low: 0.3
  };

  // Camera reference for distance calculations
  private camera: THREE.Camera | null = null;
  private sceneCenter = new THREE.Vector3(0, 0, 0);

  // Reused scratch vectors for the per-frame LOD math. getPathwayLodLevel /
  // getPulseLodLevel run for every pathway and every active pulse each frame;
  // allocating fresh Vector3s there was the single largest source of GC
  // pressure in the render loop (hundreds of thousands of allocs/sec).
  private readonly _scratchA = new THREE.Vector3();
  private readonly _scratchB = new THREE.Vector3();
  private readonly _scratchC = new THREE.Vector3();

  // Performance settings that can be adjusted
  private neuronDensityScale = 1.0; // multiplier for base density
  private pulseCountScale = 1.0;    // multiplier for base maxPulses
  private pathwayDetailScale = 1.0; // multiplier for pathway segments (not used yet)

  // Statistics
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private currentFps = 60;

  constructor() {
    // Bind methods for use in event listeners if needed
    this.update = this.update.bind(this);
  }

  /**
   * Set the camera used for distance calculations
   */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /**
   * Set the scene center (default is origin)
   */
  setSceneCenter(center: THREE.Vector3): void {
    this.sceneCenter.copy(center);
  }

  /**
   * Update performance metrics and adjust settings
   * @param deltaTime Frame time in milliseconds
   */
  update(deltaTime: number): void {
    // Update EMA of frame time
    this.emaFrameTime = this.emaFrameTime * (1 - this.alpha) + deltaTime * this.alpha;
    this.currentFps = 1000 / this.emaFrameTime;

    // Adjust performance settings based on frame time
    this.adjustPerformanceSettings();

    // Update frame count for FPS calculation
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 1000) {
      // Update FPS every second
      this.lastFpsUpdate = now;
    }
  }

  /**
   * Adjust internal performance settings based on current frame time
   * More aggressive adjustments when performance is poor
   */
  private adjustPerformanceSettings(): void {
    const timeRatio = this.emaFrameTime / this.targetFrameTime; // >1 means slower than target

    if (timeRatio > 1.2) {
      // Significantly over target frame time - reduce quality
      this.neuronDensityScale = Math.max(0.5, this.neuronDensityScale * 0.95);
      this.pulseCountScale = Math.max(0.5, this.pulseCountScale * 0.9);
    } else if (timeRatio < 0.8) {
      // Significantly under target frame time - can increase quality
      this.neuronDensityScale = Math.min(2.0, this.neuronDensityScale * 1.02);
      this.pulseCountScale = Math.min(2.0, this.pulseCountScale * 1.01);
    }
    // Clamp to reasonable ranges
    this.neuronDensityScale = Math.max(0.3, Math.min(2.0, this.neuronDensityScale));
    this.pulseCountScale = Math.max(0.3, Math.min(2.0, this.pulseCountScale));
  }

  /**
   * Get the adjusted neuron density for neural graph generation
   * @param baseDensity Base density from performance preset
   * @returns Adjusted density considering performance scaling
   */
  getAdjustedDensity(baseDensity: number): number {
    return baseDensity * this.neuronDensityScale;
  }

  /**
   * Get the adjusted max pulse count for signal simulation
   * @param baseMaxPulses Base max pulses from performance preset
   * @returns Adjusted max pulse count
   */
  getAdjustedMaxPulses(baseMaxPulses: number): number {
    return Math.round(baseMaxPulses * this.pulseCountScale);
  }

  /**
   * Calculate LOD level for a neuron based on its position
   * @param position World position of the neuron
   * @returns LOD level (0=high, 1=medium, 2=low, 3=culled)
   */
  getNeuronLodLevel(position: THREE.Vector3): number {
    if (!this.camera) return 0;
    const distance = this.camera.position.distanceTo(position);
    const thresholds = this.lodThresholds.neuron;
    if (distance < thresholds.high) return 0;
    if (distance < thresholds.medium) return 1;
    if (distance < thresholds.low) return 2;
    return 3; // culled
  }

  /**
   * Get scale factor for neuron size based on LOD level
   * @param lodLevel LOD level (0-2)
   * @returns Scale factor (0-1)
   */
  getNeuronLodScale(lodLevel: number): number {
    if (lodLevel >= 3) return 0; // culled
    const scales = [this.lodScales.high, this.lodScales.medium, this.lodScales.low];
    return scales[lodLevel];
  }

  /**
   * Calculate LOD level for a pathway based on distance from camera to pathway midpoint
   * @param pathway The pathway to check
   * @param nodes Array of neuron nodes to get positions
   * @returns LOD level (0=high, 1=medium, 2=low, 3=culled)
   */
  getPathwayLodLevel(pathway: SynapticPathway, nodes: NeuronNode[]): number {
    if (!this.camera) return 0;
    const source = nodes[pathway.source].position;
    const target = nodes[pathway.target].position;
    const midpoint = this._scratchC.set(
      (source[0] + target[0]) * 0.5,
      (source[1] + target[1]) * 0.5,
      (source[2] + target[2]) * 0.5,
    );
    const distance = this.camera.position.distanceTo(midpoint);
    const thresholds = this.lodThresholds.pathway;
    if (distance < thresholds.high) return 0;
    if (distance < thresholds.medium) return 1;
    if (distance < thresholds.low) return 2;
    return 3;
  }

  /**
   * Get intensity multiplier for pathway color based on LOD level
   * @param lodLevel LOD level (0-2)
   * @returns Intensity multiplier (0-1)
   */
  getPathwayLodIntensity(lodLevel: number): number {
    if (lodLevel >= 3) return 0; // culled
    const scales = [this.lodScales.high, this.lodScales.medium, this.lodScales.low];
    return scales[lodLevel];
  }

  /**
   * Calculate LOD level for a pulse based on its current position
   * @param pulse The pulse to check
   * @param pathway The pathway the pulse is on
   * @param nodes Array of neuron nodes
   * @returns LOD level (0=high, 1=medium, 2=low, 3=culled)
   */
  getPulseLodLevel(pulse: SignalPulse, pathway: SynapticPathway, nodes: NeuronNode[]): number {
    if (!this.camera) return 0;
    // Get pulse position along the pathway (reused scratch vectors, no per-call alloc)
    const from = nodes[pulse.fromNode].position;
    const to = nodes[pulse.toNode].position;
    const fromPos = this._scratchA.set(from[0], from[1], from[2]);
    const toPos = this._scratchB.set(to[0], to[1], to[2]);
    const t = pulse.reverse ? 1 - pulse.progress : pulse.progress;
    const pulsePos = this._scratchC.copy(fromPos).lerp(toPos, t);

    const distance = this.camera.position.distanceTo(pulsePos);
    const thresholds = this.lodThresholds.pulse;
    if (distance < thresholds.high) return 0;
    if (distance < thresholds.medium) return 1;
    if (distance < thresholds.low) return 2;
    return 3;
  }

  /**
   * Get scale factor for pulse size based on LOD level
   * @param lodLevel LOD level (0-2)
   * @returns Scale factor (0-1)
   */
  getPulseLodScale(lodLevel: number): number {
    if (lodLevel >= 3) return 0; // culled
    const scales = [this.lodScales.high, this.lodScales.medium, this.lodScales.low];
    return scales[lodLevel];
  }

  /**
   * Determine if a neuron should be rendered based on LOD
   * @param position World position of the neuron
   * @returns True if should render
   */
  shouldRenderNeuron(position: THREE.Vector3): boolean {
    return this.getNeuronLodLevel(position) < 3;
  }

  /**
   * Determine if a pathway should be rendered based on LOD
   * @param pathway The pathway to check
   * @param nodes Array of neuron nodes
   * @returns True if should render
   */
  shouldRenderPathway(pathway: SynapticPathway, nodes: NeuronNode[]): boolean {
    return this.getPathwayLodLevel(pathway, nodes) < 3;
  }

  /**
   * Determine if a pulse should be rendered based on LOD
   * @param pulse The pulse to check
   * @param pathway The pathway the pulse is on
   * @param nodes Array of neuron nodes
   * @returns True if should render
   */
  shouldRenderPulse(pulse: SignalPulse, pathway: SynapticPathway, nodes: NeuronNode[]): boolean {
    return this.getPulseLodLevel(pulse, pathway, nodes) < 3;
  }

  /**
   * Get current FPS
   */
  getFps(): number {
    return this.currentFps;
  }

  /**
   * Get current frame time in milliseconds
   */
  getFrameTime(): number {
    return this.emaFrameTime;
  }

  /**
   * Reset performance manager to default state
   */
  reset(): void {
    this.emaFrameTime = this.targetFrameTime;
    this.currentFps = 60;
    this.neuronDensityScale = 1.0;
    this.pulseCountScale = 1.0;
    this.pathwayDetailScale = 1.0;
    this.frameCount = 0;
    this.lastFpsUpdate = 0;
  }
}

// Static helper for clamping numbers
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}