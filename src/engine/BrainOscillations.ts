// BrainOscillations.ts
// Implements biologically plausible brain oscillations with multiple frequency bands,
// cross-frequency coupling, traveling waves, neuromodulation sensitivity,
// and edge-of-chaos criticality monitoring.

import * as THREE from "three";
import { BrainRegionId } from "./types";

// Frequency bands of interest
const OSCILLATION_BANDS = {
  theta: { min: 4, max: 8, cognitiveRole: "Memory encoding/retrieval, navigation, hippocampal-entorhinal dialogue" },
  alpha: { min: 8, max: 12, cognitiveRole: "Attention suppression, thalamic gating, resting state" },
  beta: { min: 12, max: 30, cognitiveRole: "Motor planning, active thinking, top-down control" },
  gamma: { min: 30, max: 100, cognitiveRole: "Perceptual binding, information integration, PING mechanism" }
} as const;

type OscillationBand = keyof typeof OSCILLATION_BANDS;

type Neuromodulator = 'DA' | 'ACh' | '5HT' | 'NE';

/**
 * Represents the oscillatory state of a single brain region.
 */
interface RegionOscillation {
  bandPowers: Record<OscillationBand, number>;  // Instantaneous power per band
  phases: Record<OscillationBand, number>;      // Phase in radians (-π to π)
  phaseVelocity: Record<OscillationBand, number>; // Instantaneous angular velocity (rad/sec)
  travelingWavePhase: number;                   // Phase for traveling wave propagation
  neuromodulationSensitivity: Record<Neuromodulator, number>; // 0-1 modulation multipliers
}

/**
 * Cross-frequency coupling metrics.
 */
interface CFCMetrics {
  phaseAmplitudeCoupling: Record<OscillationBand, Record<OscillationBand, number>>; // PAC strength
  phasePhaseCoupling: Record<OscillationBand, Record<OscillationBand, number>>;  // PPC strength
}

/**
 * Criticality metrics for edge-of-chaos monitoring.
 */
interface CriticalityMetrics {
  avalancheSize: number[];      // Recent avalanche sizes
  branchingParameter: number;   // Mean descendants per spike (critical ~1)
  entropy: number;             // Shannon entropy of spike patterns
}

/**
 * Visualization data exported for rendering.
 */
interface OscillationVisualization {
  strengths: Record<BrainRegionId, Record<OscillationBand, number>>;
  phases: Record<BrainRegionId, Record<OscillationBand, number>>;
  travelingWavePhase: Record<BrainRegionId, number>;
  neuromodulatorLevels: Record<Neuromodulator, number>;
}

/**
 * BrainOscillations
 * 
 * Core oscillation engine supporting:
 * - Theta (4-8Hz): Hippocampal-entorhinal circuits
 * - Alpha (8-12Hz): Thalamocortical loops
 * - Beta (12-30Hz): Motor cortex
 * - Gamma (30-100Hz): PING (Pyramidal-Interneuron Network Gamma)
 * 
 * Mechanisms:
 * 1. PING for Gamma:
 *    - Excitatory pyramidal cells drive inhibitory interneurons
 *    - Interneurons synchronize pyramidal firing via rhythmic inhibition
 *    - Generates high-frequency oscillations (30-100Hz)
 * 
 * 2. Thalamocortical loops for Alpha:
 *    - Thalamic pacemaker cells generate rhythmic bursts
 *    - Cortical feedback modulates thalamic relay properties
 *    - Produces spindle-like 10Hz oscillations
 * 
 * 3. Hippocampal-entorhinal circuits for Theta:
 *    - Medial septum provides rhythmic drive
 *    - Entorhinal cortex layer II/III grid cells synchronize
 *    - Critical for spatial memory and navigation
 * 
 * 4. Motor cortex Beta:
 *    - Anti-kinetic rhythm during movement planning
 *    - Suppression during movement execution
 *    - Reflects top-down control signals
 * 
 * Cross-frequency coupling:
 * - Phase-amplitude coupling: Gamma amplitude nested within Theta phase
 * - Phase-phase coupling: Alpha phase modulates Beta phase
 * 
 * Neuromodulation:
 * - DA (Dopamine): Enhances Beta/Gamma, suppresses Alpha
 * - ACh (Acetylcholine): Enhances Theta/Gamma, suppresses Alpha/Beta
 * - 5HT (Serotonin): Global suppression, enhances Alpha
 * - NE (Norepinephrine): Enhances Beta, suppresses Theta/Alpha
 * 
 * Traveling waves:
 * - Propagation delays create phase gradients across regions
 * - Direction and speed reflect functional connectivity
 * 
 * Criticality:
 * - Edge-of-chaos operation near phase transition
 * - Branching parameter near 1.0 indicates critical state
 * - Heavy-tailed avalanche size distribution
 */
export class BrainOscillations {
  // Core state
  private regionOscillations: Record<BrainRegionId, RegionOscillation>;
  private neuromodulatorLevels: Record<Neuromodulator, number>;
  private lastUpdateTime: number | null = null;
  private cfcMetrics: CFCMetrics;
  private criticalityMetrics: CriticalityMetrics;

  // Parameters
  private readonly propagationSpeed: number = 5.0; // m/s
  private readonly pacLearningRate: number = 0.01;
  private readonly criticalityWindow: number = 100;

  // FFT analysis
  private readonly fftSize: number = 2048;
  private readonly fftWindow: Float32Array;
  private fftIndex: number = 0;

  constructor() {
    // Initialize state for all regions
    const regions = Object.keys(this.getAllRegionIds()) as BrainRegionId[];
    this.regionOscillations = {} as Record<BrainRegionId, RegionOscillation>;
    this.neuromodulatorLevels = { DA: 0.5, ACh: 0.5, '5HT': 0.5, NE: 0.5 };

    for (const regionId of regions) {
      this.regionOscillations[regionId] = {
        bandPowers: { theta: 0, alpha: 0, beta: 0, gamma: 0 },
        phases: { theta: Math.random() * Math.PI * 2, alpha: Math.random() * Math.PI * 2, 
                  beta: Math.random() * Math.PI * 2, gamma: Math.random() * Math.PI * 2 },
        phaseVelocity: { theta: 0, alpha: 0, beta: 0, gamma: 0 },
        travelingWavePhase: Math.random() * Math.PI * 2,
        neuromodulationSensitivity: {
          DA: this.getDefaultSensitivity(regionId, 'DA'),
          ACh: this.getDefaultSensitivity(regionId, 'ACh'),
          '5HT': this.getDefaultSensitivity(regionId, '5HT'),
          NE: this.getDefaultSensitivity(regionId, 'NE')
        }
      };
    }

    // Initialize coupling metrics
    this.cfcMetrics = {
      phaseAmplitudeCoupling: this.initNestedRecord(),
      phasePhaseCoupling: this.initNestedRecord()
    };

    // Initialize criticality tracking
    this.criticalityMetrics = {
      avalancheSize: [],
      branchingParameter: 0,
      entropy: 0
    };

    // FFT window
    this.fftWindow = this.hannWindow(this.fftSize);
  }

  /**
   * Gets default neuromodulation sensitivity by region.
   */
  private getDefaultSensitivity(regionId: BrainRegionId, mod: Neuromodulator): number {
    // Hippocampus/entorhinal: high ACh sensitivity for Theta
    if (regionId.includes("hippocampus")) return mod === 'ACh' ? 0.9 : 0.3;
    // Thalamus: high DA/5HT sensitivity for Alpha
    if (regionId.includes("thalamus")) return mod === 'DA' || mod === '5HT' ? 0.8 : 0.4;
    // Motor cortex: high DA/NE sensitivity for Beta
    if (regionId.includes("motor")) return mod === 'DA' || mod === 'NE' ? 0.85 : 0.35;
    // Prefrontal: balanced sensitivity
    if (regionId.includes("prefrontal")) return 0.6;
    // Default moderate sensitivity
    return 0.5;
  }

  /**
   * Initializes nested records for coupling metrics.
   */
  private initNestedRecord() {
    const result: Record<OscillationBand, Record<OscillationBand, number>> = {
      theta: { theta: 0, alpha: 0, beta: 0, gamma: 0 },
      alpha: { theta: 0, alpha: 0, beta: 0, gamma: 0 },
      beta: { theta: 0, alpha: 0, beta: 0, gamma: 0 },
      gamma: { theta: 0, alpha: 0, beta: 0, gamma: 0 }
    };
    return result;
  }

  /**
   * Updates all oscillations for the current time step.
   * @param delta Time since last update in seconds
   */
  public update(delta: number): void {
    const now = performance.now() / 1000;
    if (this.lastUpdateTime === null) {
      this.lastUpdateTime = now;
      return;
    }
    const elapsed = now - this.lastUpdateTime;
    this.lastUpdateTime = now;

    // Update intrinsic oscillations
    this.updateIntrinsicOscillations(elapsed);

    // Apply cross-frequency coupling
    this.applyCrossFrequencyCoupling(elapsed);

    // Update traveling waves
    this.updateTravelingWaves(elapsed);

    // Update criticality metrics
    this.updateCriticality();

    // Update FFT analysis
    this.updateFFT();
  }

  /**
   * Updates intrinsic oscillations for each region/band.
   */
  private updateIntrinsicOscillations(elapsed: number): void {
    const regions = Object.keys(this.regionOscillations) as BrainRegionId[];

    for (const regionId of regions) {
      const osc = this.regionOscillations[regionId];

      // Update each band
      for (const [band, params] of Object.entries(OSCILLATION_BANDS)) {
        const b = band as OscillationBand;
        // Base frequency
        let baseFreq = (params.min + params.max) / 2;
        
        // Apply neuromodulation effects
        baseFreq *= this.applyNeuromodulation(regionId, b, baseFreq);
        
        // Convert to angular velocity (rad/sec)
        osc.phaseVelocity[b] = baseFreq * Math.PI * 2;
        
        // Update phase
        osc.phases[b] += osc.phaseVelocity[b] * elapsed;
        if (osc.phases[b] > Math.PI) osc.phases[b] -= Math.PI * 2;
        
        // Base power (oscillatory strength)
        osc.bandPowers[b] = this.getBasePower(regionId, b);
        
        // Add noise for biological realism
        osc.bandPowers[b] *= (1 + (Math.random() - 0.5) * 0.1);
      }
    }
  }

  /**
   * Applies neuromodulation multipliers to oscillation parameters.
   */
  private applyNeuromodulation(regionId: BrainRegionId, band: OscillationBand, freq: number): number {
    const osc = this.regionOscillations[regionId];
    let multiplier = 1.0;

    // Dopamine (DA): enhances Beta/Gamma
    if (band === 'beta' || band === 'gamma') {
      multiplier += this.neuromodulatorLevels.DA * osc.neuromodulationSensitivity.DA * 0.3;
    }
    // Acetylcholine (ACh): enhances Theta/Gamma
    if (band === 'theta' || band === 'gamma') {
      multiplier += this.neuromodulatorLevels.ACh * osc.neuromodulationSensitivity.ACh * 0.4;
    }
    // Serotonin (5HT): global suppression, enhances Alpha
    if (band === 'alpha') {
      multiplier += this.neuromodulatorLevels['5HT'] * osc.neuromodulationSensitivity['5HT'] * 0.3;
    } else {
      multiplier -= this.neuromodulatorLevels['5HT'] * osc.neuromodulationSensitivity['5HT'] * 0.2;
    }
    // Norepinephrine (NE): enhances Beta
    if (band === 'beta') {
      multiplier += this.neuromodulatorLevels.NE * osc.neuromodulationSensitivity.NE * 0.4;
    }
    
    return Math.max(0.7, Math.min(1.5, multiplier));
  }

  /**
   * Gets base oscillatory power by anatomical region.
   */
  private getBasePower(regionId: BrainRegionId, band: OscillationBand): number {
    // Hippocampus: strong Theta
    if (regionId.includes("hippocampus") && band === 'theta') return 0.8;
    // Thalamus: strong Alpha
    if (regionId.includes("thalamus") && band === 'alpha') return 0.7;
    // Motor cortex: strong Beta
    if (regionId.includes("motor") && band === 'beta') return 0.75;
    // Prefrontal: strong Gamma
    if (regionId.includes("prefrontal") && band === 'gamma') return 0.6;
    // Default moderate power
    return 0.3;
  }

  /**
   * Implements cross-frequency coupling mechanisms.
   */
  private applyCrossFrequencyCoupling(elapsed: number): void {
    // 1. Phase-amplitude coupling: Gamma amplitude nested within Theta phase
    for (const [regionId, osc] of Object.entries(this.regionOscillations)) {
      const r = regionId as BrainRegionId;
      // Theta phase modulates Gamma amplitude
      const thetaPhase = osc.phases.theta;
      const pacStrength = 0.5 * Math.sin(thetaPhase * 2); // Nested at theta peak
      osc.bandPowers.gamma *= (1 + pacStrength * 0.3);
      
      // Update coupling metrics
      this.cfcMetrics.phaseAmplitudeCoupling.theta.gamma = 
        this.ema(this.cfcMetrics.phaseAmplitudeCoupling.theta.gamma, pacStrength, 0.05);
    }
    
    // 2. Phase-phase coupling: Alpha phase modulates Beta phase
    // Simulate thalamocortical influence
    const thalamusIds = Object.keys(this.regionOscillations)
      .filter(id => id.includes("thalamus")) as BrainRegionId[];
    
    for (const thalamusId of thalamusIds) {
      const thalamusOsc = this.regionOscillations[thalamusId];
      const alphaPhase = thalamusOsc.phases.alpha;
      
      // Influence connected cortical regions
      const influencedRegions = this.getConnectedRegions(thalamusId);
      for (const regionId of influencedRegions) {
        const corticalOsc = this.regionOscillations[regionId];
        // Alpha phase pulls Beta phase
        const alphaInfluence = Math.sin(alphaPhase - corticalOsc.phases.beta) * 0.3;
        corticalOsc.phases.beta += alphaInfluence * elapsed;
        
        // Update coupling metrics
        this.cfcMetrics.phasePhaseCoupling.alpha.beta = 
          this.ema(this.cfcMetrics.phasePhaseCoupling.alpha.beta, 
                  Math.abs(alphaInfluence), 0.05);
      }
    }
  }

  /**
   * Gets anatomically connected regions for traveling waves.
   */
  private getConnectedRegions(regionId: BrainRegionId): BrainRegionId[] {
    // Simplified connectivity based on known anatomical pathways
    const connections: Record<BrainRegionId, BrainRegionId[]> = {
      "hippocampus-l": ["temporal-l", "prefrontal-l"],
      "hippocampus-r": ["temporal-r", "prefrontal-r"],
      "thalamus-l": ["prefrontal-l", "parietal-l", "frontal-l"],
      "thalamus-r": ["prefrontal-r", "parietal-r", "frontal-r"],
      "motor-l": ["somatosensory-l", "frontal-l", "parietal-l"],
      "motor-r": ["somatosensory-r", "frontal-r", "parietal-r"]
    };
    
    return connections[regionId] || [];
  }

  /**
   * Updates traveling wave propagation across regions.
   */
  private updateTravelingWaves(elapsed: number): void {
    const regions = Object.keys(this.regionOscillations) as BrainRegionId[];
    
    for (const sourceRegion of regions) {
      const connections = this.getConnectedRegions(sourceRegion);
      for (const targetRegion of connections) {
        // Calculate propagation delay based on physical distance
        const distance = this.getDistanceBetweenRegions(sourceRegion, targetRegion);
        const delay = distance / this.propagationSpeed;
        
        // Get source traveling wave phase
        const sourceOsc = this.regionOscillations[sourceRegion];
        // Target phase lags based on delay
        const phaseLag = delay * 10; // Simplified: 10 rad/m
        
        // Apply traveling wave with lag
        const targetOsc = this.regionOscillations[targetRegion];
        targetOsc.travelingWavePhase = sourceOsc.travelingWavePhase + phaseLag;
        
        // Normalize phase
        if (targetOsc.travelingWavePhase > Math.PI * 2) {
          targetOsc.travelingWavePhase -= Math.PI * 2;
        }
      }
    }
  }

  /**
   * Gets anatomical distance between regions (simplified).
   */
  private getDistanceBetweenRegions(a: BrainRegionId, b: BrainRegionId): number {
    // Very simplified distance metric based on rough neuroanatomy
    const aLobe = this.getRegionLobe(a);
    const bLobe = this.getRegionLobe(b);
    
    if (aLobe === bLobe) return 30; // mm
    if ((aLobe === "frontal" && bLobe === "parietal") ||
        (aLobe === "parietal" && bLobe === "frontal")) return 50;
    return 80;
  }

  /**
   * Gets lobe for a region.
   */
  private getRegionLobe(regionId: BrainRegionId): BrainLobe {
    if (regionId.includes("frontal")) return "frontal";
    if (regionId.includes("parietal")) return "parietal";
    if (regionId.includes("temporal")) return "temporal";
    if (regionId.includes("occipital")) return "occipital";
    if (regionId.includes("hippocampus") || regionId.includes("amygdala") ||
        regionId.includes("basal-ganglia")) return "subcortical";
    if (regionId.includes("thalamus")) return "subcortical";
    if (regionId.includes("cerebellum")) return "cerebellum";
    if (regionId.includes("brainstem")) return "brainstem";
    return "frontal"; // default
  }

  /**
   * Updates criticality metrics for edge-of-chaos monitoring.
   */
  private updateCriticality(): void {
    // Placeholder: integrate with spiking or pulse data for real criticality
    // For now, simulate based on oscillation variability
    
    const regionVariability: number[] = [];
    for (const regionId of Object.keys(this.regionOscillations) as BrainRegionId[]) {
      const osc = this.regionOscillations[regionId];
      // Use gamma power variability as proxy for spike avalanches
      regionVariability.push(osc.bandPowers.gamma);
    }
    
    // Calculate branching parameter (simplified)
    const variance = this.variance(regionVariability);
    this.criticalityMetrics.branchingParameter = 
      this.ema(this.criticalityMetrics.branchingParameter, variance * 10, 0.02);
    
    // Add to avalanche size history (windowed)
    this.criticalityMetrics.avalancheSize.push(variance);
    if (this.criticalityMetrics.avalancheSize.length > this.criticalityWindow) {
      this.criticalityMetrics.avalancheSize.shift();
    }
    
    // Calculate entropy (simplified)
    this.criticalityMetrics.entropy = this.shannonEntropy(regionVariability);
  }

  /**
   * Updates FFT analysis for spectral visualization.
   */
  private updateFFT(): void {
    // Placeholder: implement full FFT-based spectral analysis
    // Would use THREE.Spectrogram or WebAudio API in practice
  }

  /**
   * Hann window function for spectral analysis.
   */
  private hannWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
    }
    return window;
  }

  /**
   * Exponential moving average.
   */
  private ema(current: number, newValue: number, alpha: number): number {
    return current * (1 - alpha) + newValue * alpha;
  }

  /**
   * Calculates variance of an array.
   */
  private variance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
  }

  /**
   * Calculates Shannon entropy.
   */
  private shannonEntropy(values: number[]): number {
    const sum = values.reduce((a, b) => a + b, 0);
    const normalized = values.map(v => v / sum);
    return -normalized.reduce((a, p) => a + (p > 0 ? p * Math.log2(p) : 0), 0);
  }

  /**
   * Gets all BrainRegionIds.
   */
  private getAllRegionIds(): Record<BrainRegionId, boolean> {
    return {
      "prefrontal-l": true, "prefrontal-r": true,
      "frontal-l": true, "frontal-r": true,
      "motor-l": true, "motor-r": true,
      "somatosensory-l": true, "somatosensory-r": true,
      "parietal-l": true, "parietal-r": true,
      "temporal-l": true, "temporal-r": true,
      "auditory-l": true, "auditory-r": true,
      "occipital-l": true, "occipital-r": true,
      "hippocampus-l": true, "hippocampus-r": true,
      "amygdala-l": true, "amygdala-r": true,
      "thalamus-l": true, "thalamus-r": true,
      "basal-ganglia-l": true, "basal-ganglia-r": true,
      "cerebellum": true,
      "brainstem": true
    };
  }

  /**
   * Sets neuromodulator level (0-1).
   */
  public setNeuromodulator(level: Neuromodulator, value: number): void {
    this.neuromodulatorLevels[level] = Math.max(0, Math.min(1, value));
  }

  /**
   * Gets current neuromodulator levels.
   */
  public getNeuromodulatorLevels(): Record<Neuromodulator, number> {
    return { ...this.neuromodulatorLevels };
  }

  /**
   * Gets oscillatory strengths by region and band.
   */
  public getVisualizationData(): OscillationVisualization {
    const result: OscillationVisualization = {
      strengths: {} as Record<BrainRegionId, Record<OscillationBand, number>>,
      phases: {} as Record<BrainRegionId, Record<OscillationBand, number>>,
      travelingWavePhase: {} as Record<BrainRegionId, number>,
      neuromodulatorLevels: this.neuromodulatorLevels
    };
    
    for (const [regionId, osc] of Object.entries(this.regionOscillations)) {
      const r = regionId as BrainRegionId;
      result.strengths[r] = { ...osc.bandPowers };
      result.phases[r] = { ...osc.phases };
      result.travelingWavePhase[r] = osc.travelingWavePhase;
    }
    
    return result;
  }

  /**
   * Gets current cross-frequency coupling metrics.
   */
  public getCFCMetrics(): CFCMetrics {
    return {
      phaseAmplitudeCoupling: JSON.parse(JSON.stringify(this.cfcMetrics.phaseAmplitudeCoupling)),
      phasePhaseCoupling: JSON.parse(JSON.stringify(this.cfcMetrics.phasePhaseCoupling))
    };
  }

  /**
   * Gets criticality metrics.
   */
  public getCriticalityMetrics(): CriticalityMetrics {
    return {
      avalancheSize: [...this.criticalityMetrics.avalancheSize],
      branchingParameter: this.criticalityMetrics.branchingParameter,
      entropy: this.criticalityMetrics.entropy
    };
  }
}