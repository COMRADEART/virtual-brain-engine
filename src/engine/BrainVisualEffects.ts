import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { REGION_BY_ID, REGION_INDEX } from "./brainRegions";
import { PATHWAY_SEGMENTS } from "./neuralGraphGenerator";
import { Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { SpikingEngine } from "./SpikingEngine";
import type { NeuralGraphRenderer } from "../components/NeuralGraph";
import type {
  BrainRegionId,
  BrainSimulation,
  NeuralGraph,
  RegionVisibility,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Shared scratch
// ─────────────────────────────────────────────────────────────────────────────
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _color = new THREE.Color();

// Bulk-copy src into dst (clamped to the shorter of the two) via the typed-array
// fast path instead of an element loop — these run per frame over every neuron.
function copyInto(dst: Float32Array, src: Float32Array): void {
  if (src.length <= dst.length) {
    dst.set(src);
  } else {
    dst.set(src.subarray(0, dst.length));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Neuron membrane-potential vertex shader
// Reads per-instance attributes: membraneNorm, neuronType, burstStatus
import { NEURON_VERT, NEURON_FRAG, PATHWAY_VERT, PATHWAY_FRAG, TRAIL_VERT, TRAIL_FRAG, REGION_BREATHE_VERT, REGION_BREATHE_FRAG, NT_VERT, NT_FRAG, EEG_VERT, EEG_FRAG, NEUROMOD_SHADER, FILM_GRAIN_SHADER } from "./shaders";

// ─────────────────────────────────────────────────────────────────────────────
// BrainVisualEffects — master effects class.
//
// Call `update()` every frame with the live simulation to drive all effects.
// Add `group` to your Three.js scene.  If `createPostProcessing` is true the
// class builds its own EffectComposer (useful when BrainVisualEffects is the
// only post-processing consumer; pass false when BrainScene already owns a
// composer and you'll pull the neuromod pass in yourself).
// ─────────────────────────────────────────────────────────────────────────────
export class BrainVisualEffects {
  readonly group = new THREE.Group();
  readonly enabled: boolean;

  private graph: NeuralGraph;
  private simulation: BrainSimulation;

  // ── Oscillation state (mirrors SpikingEngine internals for effects) ────────
  private thetaPhase = 0;
  private gammaPhase = 0;
  private dopamine = 0.3;
  private acetylcholine = 0.4;
  private serotonin = 0.2;
  private norepinephrine = 0.1;

  // ── Neuromodulator override (external callers can set these) ────────────────
  setDopamine(v: number) { this.dopamine = Math.max(0, Math.min(1, v)); }
  setAcetylcholine(v: number) { this.acetylcholine = Math.max(0, Math.min(1, v)); }
  setOscillationPhases(theta: number, gamma: number) {
    this.thetaPhase = theta;
    this.gammaPhase = gamma;
  }

  // ── Material factories ──────────────────────────────────────────────────────
  private neuronMaterial!: THREE.ShaderMaterial;
  private pathwayMaterial!: THREE.ShaderMaterial;

  // ── Layers ──────────────────────────────────────────────────────────────────
  private regionBreatheGroup = new THREE.Group();
  private pulseTrailLines!: THREE.LineSegments;
  private ntParticles!: THREE.Points;
  private eegWaveform!: THREE.Mesh;
  private eegSampleAttr!: THREE.BufferAttribute;

  // ── Post-processing ─────────────────────────────────────────────────────────
  private composer: EffectComposer | null = null;
  private neuromodPass: ShaderPass | undefined;
  private filmGrainPass: ShaderPass | undefined;
  private readonly useOwnComposer: boolean;

  // ── Per-region cached data ───────────────────────────────────────────────────
  private readonly regionMeshMap = new Map<BrainRegionId, THREE.Mesh>();
  private readonly regionMaterialMap = new Map<BrainRegionId, THREE.ShaderMaterial>();
  private readonly regionBreathePhase = new Float32Array(32);
  // Rich-club hub state — set once via highlightRichClubHubs, consumed by
  // updateRegionBreathing (the single per-frame writer of the breathing
  // uniforms, so the two never fight over uRegionColor/uThetaGain).
  private readonly richClubHubs = new Set<BrainRegionId>();
  private richClubIntensity = 0;

  // scratch for trail geometry
  private trailPosBuffer!: Float32Array;
  private trailProgressBuffer!: Float32Array;
  private trailIntensityBuffer!: Float32Array;

  // NT particle scratch
  private ntPos!: Float32Array;
  private ntVel!: Float32Array;
  private ntLife!: Float32Array;
  private ntType!: Float32Array;
  private ntSizeArr!: Float32Array;
  private ntCursor = 0;
  private readonly MAX_NT_PARTICLES = 1200;

  // activity buffer for pathway shader update
  private pathwayActivityBuffer!: Float32Array;

  constructor(
    graph: NeuralGraph,
    simulation: BrainSimulation,
    opts: {
      enableNeuromodTint?: boolean;
      enableNeurotransmitterParticles?: boolean;
      enableEegOverlay?: boolean;
      enableRegionBreathing?: boolean;
      enablePulseTrails?: boolean;
      useOwnComposer?: boolean;
      enableWorkingMemory?: boolean;
      enableSpikeRaster?: boolean;
    } = {},
  ) {
    const o = {
      enableNeuromodTint: true,
      enableNeurotransmitterParticles: true,
      enableEegOverlay: true,
      enableRegionBreathing: true,
      enablePulseTrails: true,
      enableWorkingMemory: false,
      useOwnComposer: false,
      ...opts,
    };
    this.useOwnComposer = o.useOwnComposer;

    this.graph = graph;
    this.simulation = simulation;
    this.enabled = true;
    
    // Initialize neuromodulators
    this.dopamine = 0.3;
    this.acetylcholine = 0.4;
    this.serotonin = 0.2;
    this.norepinephrine = 0.1;

    this.group.name = "BrainVisualEffects";
    this.regionBreatheGroup.name = "RegionBreathing";
    this.group.add(this.regionBreatheGroup);

    this.neuronMaterial = this.createNeuronMaterial();
    this.pathwayMaterial = this.createPathwayMaterial();

    if (o.enablePulseTrails) {
      this.initPulseTrails();
    }
    if (o.enableRegionBreathing) {
      this.initRegionBreathing();
    }
    if (o.enableNeurotransmitterParticles) {
      this.initNeurotransmitterParticles();
    }
    if (o.enableEegOverlay) {
      this.initEegOverlay();
    }
    if (o.useOwnComposer && o.enableNeuromodTint) {
      this.initPostProcessing();
    }

    this.group.renderOrder = 6;
  }

  // ── Public material getters ─────────────────────────────────────────────────
  // The NeuralGraphRenderer can grab these and swap them in place of its basic
  // materials for a drop-in upgrade.
  getNeuronMaterial(): THREE.ShaderMaterial { return this.neuronMaterial; }
  getPathwayMaterial(): THREE.ShaderMaterial { return this.pathwayMaterial; }
  
  // ── Rich-club hub highlighting ────────────────────────────────────────────
  // Marks highly connected hub regions for a pulsing gold highlight. Call once
  // (or on hub-set change), NOT per frame: this only records the hub set —
  // updateRegionBreathing applies the highlight each frame with zero
  // allocations. Pass an empty array to clear.
  highlightRichClubHubs(hubRegionIds: BrainRegionId[], intensity: number = 1.0): void {
    this.richClubHubs.clear();
    for (const regionId of hubRegionIds) {
      this.richClubHubs.add(regionId);
    }
    this.richClubIntensity = intensity;
  }
  
  // ── Memory pathway highlighting ───────────────────────────────────────────
  // Highlights specific pathways used in memory replay/consolidation
  highlightMemoryPathways(pathwayIndices: number[], _intensity: number = 1.0): void {
    // This would be implemented in NeuralGraphRenderer but we define the API here
    // The renderer can use this to modify pathway colors/appearance
  }

  // ── Post-processing composer (call setSize on resize) ────────────────────────
  getComposer(): EffectComposer | null { return this.composer; }

  // ── Per-frame update ─────────────────────────────────────────────────────────
  update(
    elapsed: number,
    deltaSeconds: number,
    _visibility: RegionVisibility,
    regionIntensity: Float32Array,
    pathwayIntensity: Float32Array,
  ): void {
    const dt = deltaSeconds;

    // Advance oscillation phases (mimics SpikingEngine's inner integrator)
    const THETA_HZ = 6.0, GAMMA_HZ = 40.0;
    this.thetaPhase = (this.thetaPhase + 2 * Math.PI * THETA_HZ * dt) % (2 * Math.PI);
    this.gammaPhase = (this.gammaPhase + 2 * Math.PI * GAMMA_HZ * dt) % (2 * Math.PI);

    // Decay neuromodulators
    const DA_DECAY = 0.55, ACH_DECAY = 0.55, SEROTONIN_DECAY = 0.6, NE_DECAY = 0.7;
    this.dopamine += (0.3 - this.dopamine) * (1 - Math.pow(DA_DECAY, dt)) * 2;
    this.acetylcholine += (0.4 - this.acetylcholine) * (1 - Math.pow(ACH_DECAY, dt)) * 2;
    // Add serotonin and norepinephrine decay
    const serotoninBaseline = 0.2;
    const neBaseline = 0.1;
    this.serotonin += (serotoninBaseline - this.serotonin) * (1 - Math.pow(SEROTONIN_DECAY, dt)) * 2;
    this.norepinephrine += (neBaseline - this.norepinephrine) * (1 - Math.pow(NE_DECAY, dt)) * 2;

    // Update shader uniforms
    this.neuronMaterial.uniforms.uTime.value = elapsed;
    this.neuronMaterial.uniforms.uOscillationPhase.value = this.thetaPhase;
    this.neuronMaterial.uniforms.uGammaPhase.value = this.gammaPhase;
    this.neuronMaterial.uniforms.uGlobalActivity.value = this.computeGlobalActivity(regionIntensity);
    this.neuronMaterial.uniforms.uDopamine.value = this.dopamine;
    this.neuronMaterial.uniforms.uAcetylcholine.value = this.acetylcholine;
    // Update serotonin and norepinephrine
    this.neuronMaterial.uniforms.uSerotonin.value = this.serotonin;
    this.neuronMaterial.uniforms.uNorepinephrine.value = this.norepinephrine;

    this.pathwayMaterial.uniforms.uTime.value = elapsed;

    // Update breathing volumes
    this.updateRegionBreathing(elapsed, regionIntensity);

    // Update trail geometry
    if (this.pulseTrailLines) {
      this.updatePulseTrails(elapsed);
    }

    // Spawn / update NT particles
    if (this.ntParticles) {
      this.updateNeurotransmitterParticles(elapsed, deltaSeconds);
    }

    // Update EEG waveform
    this.updateEegWaveform(elapsed, regionIntensity, pathwayIntensity);

    // Update working memory highlights
    if (this.workingMemoryGroup) {
      this.updateWorkingMemoryVisualization(elapsed);
    }

    // Drive post-processing
    if (this.composer) {
      const tp = this.neuromodPass;
      if (tp) {
        tp.uniforms.uDopamine.value = this.dopamine;
        tp.uniforms.uAcetylcholine.value = this.acetylcholine;
        tp.uniforms.uSerotonin.value = this.serotonin;
        tp.uniforms.uNorepinephrine.value = this.norepinephrine;
        tp.uniforms.uTime.value = elapsed;
      }
      const fg = this.filmGrainPass;
      if (fg) {
        fg.uniforms.uTime.value = elapsed;
      }
    }
  }

  // Update EEG waveform
  private updateEegWaveform(elapsed: number, regionIntensity: Float32Array, pathwayIntensity: Float32Array): void {
    const samples = this.eegSampleAttr.array as Float32Array;
    const N = samples.length;

    // Synthesise a multi-band waveform that reflects brain state:
    // - theta (6 Hz), alpha (10 Hz), beta (20 Hz), gamma (40 Hz) components
    // weighted by the active region's dominant frequency band.
    const thetaW = 0.5, alphaW = 0.3, betaW = 0.4, gammaW = 0.6;

    const globalAct = this.computeGlobalActivity(regionIntensity);
    const avgPathway = this.averagePathwayActivity(pathwayIntensity);

    for (let i = 0; i < N; i++) {
      const t = (i / N) * 0.5 + elapsed; // 0.5s window
      let v = 0;
      v += Math.sin(t * 2 * Math.PI * 6 + elapsed * 0.3) * thetaW * globalAct;
      v += Math.sin(t * 2 * Math.PI * 10 + elapsed * 0.5) * alphaW * (1 - globalAct * 0.5);
      v += Math.sin(t * 2 * Math.PI * 20 + elapsed * 0.7) * betaW * avgPathway;
      v += Math.sin(t * 2 * Math.PI * 40 + elapsed * 1.1) * gammaW * globalAct * avgPathway;

      // Normalise to [-1, 1]
      samples[i] = Math.tanh(v * 0.5);
    }

    this.eegSampleAttr.needsUpdate = true;
    const mat = this.eegWaveform.material as THREE.ShaderMaterial;
    mat.uniforms.uTime.value = elapsed;
  }
  
  // Update working memory visualization
  private updateWorkingMemoryVisualization(elapsed: number): void {
    if (!this.workingMemoryGroup) return;
    
    // Animate working memory highlights with pulsing effect
    this.workingMemoryGroup.children.forEach((child, index) => {
      if (child instanceof THREE.Mesh) {
        const data = child.userData;
        if (data && data.baseIntensity !== undefined) {
          // Pulsing animation for working memory highlight
          data.animationPhase += 0.02;
          const pulse = Math.sin(elapsed * 2.0 + index * 0.5) * 0.2 + 0.8;
          const intensity = data.baseIntensity * pulse;
          
          // Update material properties
          const material = child.material as THREE.MeshStandardMaterial;
          material.emissiveIntensity = intensity * 0.7;
          material.opacity = 0.4 + intensity * 0.3;
        }
      }
    });
  }
    
  // ── Membrane potential update (for drop-in neuron shader material) ──────────
  // Call this with SpikingEngine.membranePotentialNorm to drive the heatmap.
  // If using SignalSimulation (no membrane potential), pass null and the shader
  // falls back to activity-based colouring.
  updateMembranePotential(membraneNorm: Float32Array | null): void {
    if (!membraneNorm) return;
    const attr = this.neuronAttrGeometry?.getAttribute("membraneNorm") as THREE.BufferAttribute | undefined;
    if (!attr) return;
    copyInto(attr.array as Float32Array, membraneNorm);
    attr.needsUpdate = true;
  }
  
  // ── Update neuron-specific visual attributes ───────────────────────────────
  // Sets neuron type, bursting status, and memory engagement for visualization
  updateNeuronAttributes(
    neuronType: Int8Array | null,           // 1=excitatory, -1=inhibitory
    burstStatus: Float32Array | null,      // 0-1 for bursting neurons
    memoryTrace: Float32Array | null       // 0-1 memory engagement
  ): void {
    // Update neuron type attribute (immutable after build → upload once).
    if (neuronType && !this.neuronTypeUploaded) {
      const attr = this.neuronAttrGeometry?.getAttribute("neuronType") as THREE.BufferAttribute | undefined;
      if (attr) {
        const arr = attr.array as Float32Array;
        const count = Math.min(arr.length, neuronType.length);
        for (let i = 0; i < count; i++) {
          // Convert from Int8Array to Float32: 1→1 (excitatory), -1→0 (inhibitory)
          arr[i] = neuronType[i] > 0 ? 1.0 : 0.0;
        }
        attr.needsUpdate = true;
        this.neuronTypeUploaded = true;
      }
    }
    
    // Update bursting status
    if (burstStatus) {
      const attr = this.neuronAttrGeometry?.getAttribute("burstStatus") as THREE.BufferAttribute | undefined;
      if (attr) {
        copyInto(attr.array as Float32Array, burstStatus);
        attr.needsUpdate = true;
      }
    }

    // Update memory trace
    if (memoryTrace) {
      const attr = this.neuronAttrGeometry?.getAttribute("memoryTrace") as THREE.BufferAttribute | undefined;
      if (attr) {
        copyInto(attr.array as Float32Array, memoryTrace);
        attr.needsUpdate = true;
      }
    }
  }
  
  // ── Set neuromodulator levels for visualization ──────────────────────────
  // Updates the global neuromodulator values used for visual tinting
  setNeuromodulators({
    dopamine = 0.3,
    acetylcholine = 0.4,
    serotonin = 0.2,
    norepinephrine = 0.1
  }: {
    dopamine?: number;
    acetylcholine?: number;
    serotonin?: number;
    norepinephrine?: number;
  } = {}): void {
    this.dopamine = dopamine;
    this.acetylcholine = acetylcholine;
    this.neuronMaterial.uniforms.uDopamine.value = dopamine;
    this.neuronMaterial.uniforms.uAcetylcholine.value = acetylcholine;
    
    // Update serotonin and norepinephrine if they exist in uniforms
    if ('uSerotonin' in this.neuronMaterial.uniforms) {
      this.neuronMaterial.uniforms.uSerotonin.value = serotonin;
    }
    if ('uNorepinephrine' in this.neuronMaterial.uniforms) {
      this.neuronMaterial.uniforms.uNorepinephrine.value = norepinephrine;
    }
    
    // Update neuromodulator pass if it exists
    if (this.neuromodPass) {
      this.neuromodPass.uniforms.uDopamine.value = dopamine;
      this.neuromodPass.uniforms.uAcetylcholine.value = acetylcholine;
      if ('uSerotonin' in this.neuromodPass.uniforms) {
        this.neuromodPass.uniforms.uSerotonin.value = serotonin;
      }
      if ('uNorepinephrine' in this.neuromodPass.uniforms) {
        this.neuromodPass.uniforms.uNorepinephrine.value = norepinephrine;
      }
    }
  }
  
  // ── Update gamma phase for theta-gamma coupling visualization ──────────-
  setGammaPhase(gammaPhase: number): void {
    this.gammaPhase = gammaPhase;
    this.neuronMaterial.uniforms.uGammaPhase.value = gammaPhase;
  }

  setSize(width: number, height: number): void {
    if (this.composer) this.composer.setSize(width, height);
    const fg = this.filmGrainPass;
    if (fg) fg.uniforms.uResolution.value.set(width, height);
  }

  dispose(): void {
    // Dispose all child objects
    this.group.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
    
    // Dispose working memory group if it exists
    if (this.workingMemoryGroup) {
      this.workingMemoryGroup.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
      });
    }
    
    // Dispose composer and passes. Iterate a snapshot, not the live array:
    // the previous while-loop spun forever whenever passes[0] was a kept pass
    // (neuromodPass/filmGrainPass) — it skipped removal but the array never
    // shrank, hanging the main thread under StrictMode's double-mount dispose.
    if (this.composer) {
      for (const pass of [...this.composer.passes]) {
        if (pass !== this.neuromodPass && pass !== this.filmGrainPass) {
          this.composer.removePass(pass);
        }
      }
    }
    
    if (this.neuromodPass) {
      this.neuromodPass.dispose();
      this.neuromodPass = undefined;
    }

    if (this.filmGrainPass) {
      this.filmGrainPass.dispose();
      this.filmGrainPass = undefined;
    }
    
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private: material factories
  // ══════════════════════════════════════════════════════════════════════════

  private createNeuronMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: NEURON_VERT,
      fragmentShader: NEURON_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uGlobalActivity: { value: 0 },
        uOscillationPhase: { value: 0 },
        uGammaPhase: { value: 0 },
        uDopamine: { value: 0.3 },
        uAcetylcholine: { value: 0.4 },
        uSerotonin: { value: 0.2 },
        uNorepinephrine: { value: 0.1 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  private createPathwayMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: PATHWAY_VERT,
      fragmentShader: PATHWAY_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uBaseOpacity: { value: 0.62 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private: pulse trails
  // ══════════════════════════════════════════════════════════════════════════

  private initPulseTrails(): void {
    const MAX_TRAIL_POINTS = 6000; // 260 pulses × ~23 trail segments
    const positions = new Float32Array(MAX_TRAIL_POINTS * 3);
    const progress = new Float32Array(MAX_TRAIL_POINTS);
    const intensity = new Float32Array(MAX_TRAIL_POINTS);
    const pulseType = new Float32Array(MAX_TRAIL_POINTS); // 0=regular, 1=memory, 2=inhibitory
    const dummyIdx = new Float32Array(MAX_TRAIL_POINTS);

    this.trailPosBuffer = positions;
    this.trailProgressBuffer = progress;
    this.trailIntensityBuffer = intensity;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("progress", new THREE.BufferAttribute(progress, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("intensity", new THREE.BufferAttribute(intensity, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("pulseType", new THREE.BufferAttribute(pulseType, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("index", new THREE.BufferAttribute(dummyIdx, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const lines = new THREE.LineSegments(geo, mat);
    lines.name = "PulseTrails";
    lines.renderOrder = 5;
    this.pulseTrailLines = lines;
    this.group.add(lines);
  }

private updatePulseTrails(_elapsed: number): void {
    const pulses = this.simulation.pulses;
    const pathways = this.graph.pathways;
    const nodes = this.graph.nodes;

    let writeCursor = 0;
    const maxWrite = this.trailPosBuffer.length / 3;
    const TRAIL_LEN = 14; // segments per trail

    for (const pulse of pulses) {
      if (writeCursor + TRAIL_LEN > maxWrite) break;

      const pathway = pathways[pulse.pathwayIndex];
      if (!pathway) continue;

      // Determine pulse type:
      // 0 = regular excitatory pulse
      // 1 = memory replay pulse (hippocampus to neocortex)
      // 2 = inhibitory pulse
      let pulseType = 0; // default to regular
      
      // Check if this is a memory-related pathway
      const sourceNode = nodes[pulse.fromNode];
      const targetNode = nodes[pulse.toNode];
      
      if (sourceNode && targetNode) {
        // Memory replay typically involves hippocampus and neocortex
        const hippoRegions = ["hippocampus-l", "hippocampus-r"];
        const isMemorySource = hippoRegions.includes(sourceNode.regionId);
        const isMemoryTarget = hippoRegions.includes(targetNode.regionId);
        
        // If this is a hippocampus ↔ neocortex pathway, mark as memory
        if ((isMemorySource && !isMemoryTarget) || (!isMemorySource && isMemoryTarget)) {
          pulseType = 1;
        }
        
        // Check if this comes from an inhibitory neuron (if simulation provides neuronType)
        if (this.simulation instanceof SpikingEngine && 'neuronType' in this.simulation) {
          // This would be determined by the source neuron's type in a real implementation
          // For now, we'll approximate: 20% of pulses are inhibitory
          if (Math.random() < 0.2) {
            pulseType = 2;
          }
        }
      }

      // Draw a trail of small spheres behind the pulse head
      for (let t = 0; t < TRAIL_LEN; t++) {
        const frac = t / TRAIL_LEN; // 0 = oldest, TRAIL_LEN-1 = just behind head
        const progressBehind = Math.max(0, pulse.progress - frac * 0.12);
        const headT = pulse.reverse ? 1 - progressBehind : progressBehind;
        const scaled = headT * PATHWAY_SEGMENTS;
        const i = Math.min(PATHWAY_SEGMENTS - 1, Math.floor(scaled));
        const f = scaled - i;
        const a = i * 3;
        const b = (i + 1) * 3;

        const sx = pathway.samples[a] + (pathway.samples[b] - pathway.samples[a]) * f;
        const sy = pathway.samples[a + 1] + (pathway.samples[b + 1] - pathway.samples[a + 1]) * f;
        const sz = pathway.samples[a + 2] + (pathway.samples[b + 2] - pathway.samples[a + 2]) * f;

        const ci = writeCursor * 3;
        this.trailPosBuffer[ci] = sx;
        this.trailPosBuffer[ci + 1] = sy;
        this.trailPosBuffer[ci + 2] = sz;
        this.trailProgressBuffer[writeCursor] = 1 - frac / TRAIL_LEN;
        this.trailIntensityBuffer[writeCursor] = pulse.intensity * (1 - frac / TRAIL_LEN) * 0.7;
        // Set pulse type for this trail segment
        (this.pulseTrailLines.geometry.getAttribute("pulseType") as THREE.BufferAttribute).setX(writeCursor, pulseType);

        writeCursor++;
      }
    }

    // Zero out unused slots
    for (let i = writeCursor; i < this.trailPosBuffer.length / 3; i++) {
      const ci = i * 3;
      this.trailPosBuffer[ci] = 0;
      this.trailPosBuffer[ci + 1] = 0;
      this.trailPosBuffer[ci + 2] = 0;
      this.trailProgressBuffer[i] = 0;
      this.trailIntensityBuffer[i] = 0;
    }

    const geo = this.pulseTrailLines.geometry;
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("progress") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("intensity") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("pulseType") as THREE.BufferAttribute).needsUpdate = true;
    geo.setDrawRange(0, writeCursor);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private: region breathing
  // ══════════════════════════════════════════════════════════════════════════

  private initRegionBreathing(): void {
    for (const regionId of this.graph.regionOrder) {
      const region = REGION_BY_ID[regionId];
      if (!region) continue;

      // Phase offset: each region starts at a different point in the cycle
      // to avoid a "cardiac" synchronised pulsation.
      const phaseIdx = REGION_INDEX[regionId] ?? 0;
      this.regionBreathePhase[phaseIdx] = phaseIdx * 0.41;

      const geo = new THREE.SphereGeometry(1, 24, 14);
      const mat = new THREE.ShaderMaterial({
        vertexShader: REGION_BREATHE_VERT,
        fragmentShader: REGION_BREATHE_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uThetaPhase: { value: 0 },
          uGammaPhase: { value: 0 },
          uThetaGain: { value: 1.0 },
          uGammaGain: { value: 1.0 },
          uIntensity: { value: 0.0 },
          uRegionColor: { value: new THREE.Color(region.color) },
          uRegionRadius: { value: 1.0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(region.center[0], region.center[1], region.center[2]);
      mesh.scale.set(region.radius[0], region.radius[1], region.radius[2]);

      this.regionMeshMap.set(regionId, mesh);
      this.regionMaterialMap.set(regionId, mat);
      this.regionBreatheGroup.add(mesh);
    }
  }

  private updateRegionBreathing(elapsed: number, regionIntensity: Float32Array): void {
    const localTheta = this.thetaPhase;
    const localGamma = this.gammaPhase;

    for (const regionId of this.graph.regionOrder) {
      const mesh = this.regionMeshMap.get(regionId);
      const mat = this.regionMaterialMap.get(regionId);
      if (!mesh || !mat) continue;

      const rIdx = REGION_INDEX[regionId];
      const intensity = regionIntensity[rIdx] ?? 0;

      // Region-local phase offset
      const phaseOffset = this.regionBreathePhase[rIdx] ?? 0;
      mat.uniforms.uTime.value = elapsed;
      mat.uniforms.uThetaPhase.value = localTheta + phaseOffset;
      mat.uniforms.uGammaPhase.value = localGamma + phaseOffset * 1.7;

      if (this.richClubHubs.has(regionId)) {
        // Rich-club hub: boosted gains + a theta-pulsed gold tint, written into
        // the existing uniform Color (no per-frame allocation).
        const hub = this.richClubIntensity;
        const goldPulse = Math.sin(localTheta) * 0.3 + 0.7;
        const k = hub * goldPulse * 0.5;
        mat.uniforms.uThetaGain.value = 1.2 + hub * 0.6;
        mat.uniforms.uGammaGain.value = 0.8 + hub * 0.5;
        mat.uniforms.uRegionColor.value.setRGB(1.0 * k, 0.75 * k, 0.2 * k);
      } else {
        mat.uniforms.uThetaGain.value = 0.6 + intensity * 0.8;
        mat.uniforms.uGammaGain.value = 0.3 + intensity * 0.6;
        mat.uniforms.uRegionColor.value.set(REGION_BY_ID[regionId].color);
      }
      mat.uniforms.uIntensity.value = intensity;

      mesh.visible = true;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private: neurotransmitter particle system
  // ══════════════════════════════════════════════════════════════════════════

  private initNeurotransmitterParticles(): void {
    const N = this.MAX_NT_PARTICLES;
    this.ntPos = new Float32Array(N * 3);
    this.ntVel = new Float32Array(N * 3);
    this.ntLife = new Float32Array(N);
    this.ntType = new Float32Array(N);
    this.ntSizeArr = new Float32Array(N);
    // Start all dead
    for (let i = 0; i < N; i++) this.ntLife[i] = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.ntPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("velocity", new THREE.BufferAttribute(this.ntVel, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("life", new THREE.BufferAttribute(this.ntLife, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("type", new THREE.BufferAttribute(this.ntType, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("size", new THREE.BufferAttribute(this.ntSizeArr, 1).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.ShaderMaterial({
      vertexShader: NT_VERT,
      fragmentShader: NT_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelsPerUnit: { value: 300 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.ntParticles = new THREE.Points(geo, mat);
    this.ntParticles.name = "NeurotransmitterParticles";
    this.ntParticles.renderOrder = 7;
    this.group.add(this.ntParticles);
  }

  private updateNeurotransmitterParticles(elapsed: number, dt: number): void {
    const pulses = this.simulation.pulses;
    const pathways = this.graph.pathways;

    // Spawn: one burst per pulse head, biased toward high-intensity pulses
    for (const pulse of pulses) {
      const pathway = pathways[pulse.pathwayIndex];
      if (!pathway) continue;

      // Only burst near the midpoint of travel (most synaptic)
      if (Math.abs(pulse.progress - 0.5) > 0.25) continue;
      if (Math.random() > pulse.intensity * 0.25) continue;

      const t = pulse.reverse ? 1 - pulse.progress : pulse.progress;
      const scaled = t * PATHWAY_SEGMENTS;
      const i = Math.min(PATHWAY_SEGMENTS - 1, Math.floor(scaled));
      const a = i * 3;

      const px = pathway.samples[a];
      const py = pathway.samples[a + 1];
      const pz = pathway.samples[a + 2];

      // Spawn a micro-cluster of particles at this position
      const burstSize = Math.floor(2 + pulse.intensity * 4);
      for (let b = 0; b < burstSize; b++) {
        const idx = this.ntCursor % this.MAX_NT_PARTICLES;
        const ci = idx * 3;

        this.ntPos[ci]     = px + (Math.random() - 0.5) * 0.04;
        this.ntPos[ci + 1] = py + (Math.random() - 0.5) * 0.04 + 0.06; // slight upward bias
        this.ntPos[ci + 2] = pz + (Math.random() - 0.5) * 0.04;

        this.ntVel[ci]     = (Math.random() - 0.5) * 0.08;
        this.ntVel[ci + 1] = 0.04 + Math.random() * 0.06;
        this.ntVel[ci + 2] = (Math.random() - 0.5) * 0.08;

        this.ntLife[idx] = 1.0;

        // 0=glutamate, 1=GABA, 2=dopamine, 3=acetylcholine
        const r = Math.random();
        this.ntType[idx]   = r < 0.65 ? 0 : r < 0.8 ? 1 : r < 0.9 ? 2 : 3;
        this.ntSizeArr[idx] = 0.018 + Math.random() * 0.022;

        this.ntCursor++;
      }
    }

    // Decay life
    const decayRate = 0.88; // life fraction retained per second
    const decay = Math.pow(decayRate, dt);
    for (let i = 0; i < this.MAX_NT_PARTICLES; i++) {
      if (this.ntLife[i] > 0) {
        this.ntLife[i] *= decay;
        if (this.ntLife[i] < 0.005) this.ntLife[i] = 0;
      }
    }

    const geo = this.ntParticles.geometry;
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("life") as THREE.BufferAttribute).needsUpdate = true;
    (this.ntParticles.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private: EEG / LFP waveform overlay
  // ══════════════════════════════════════════════════════════════════════════

  private initEegOverlay(): void {
    const NUM_SAMPLES = 256;
    const samples = new Float32Array(NUM_SAMPLES);
    for (let i = 0; i < NUM_SAMPLES; i++) samples[i] = 0;

    const positions = new Float32Array(NUM_SAMPLES * 3);
    for (let i = 0; i < NUM_SAMPLES; i++) positions[i * 3] = (i / (NUM_SAMPLES - 1)) * 2.4 - 1.2;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("sample", new THREE.BufferAttribute(samples, 1).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.ShaderMaterial({
      vertexShader: EEG_VERT,
      fragmentShader: EEG_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uWidth: { value: 2.4 },
        uAmplitude: { value: 0.12 },
        uAlpha: { value: 0.0 }, // starts invisible, shown via hotkey
        uColour: { value: new THREE.Color(0.2, 1.0, 0.7) },
      },
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.eegSampleAttr = geo.getAttribute("sample") as THREE.BufferAttribute;

    this.eegWaveform = new THREE.Mesh(geo, mat);
    this.eegWaveform.name = "EEGOverlay";
    this.eegWaveform.position.set(0, -1.4, 0);
    this.eegWaveform.visible = false;
    this.eegWaveform.renderOrder = 8;
    this.group.add(this.eegWaveform);
  }

  showEegOverlay(visible: boolean): void {
    if (this.eegWaveform) this.eegWaveform.visible = visible;
    const mat = this.eegWaveform?.material as THREE.ShaderMaterial | undefined;
    if (mat) mat.uniforms.uAlpha.value = visible ? 0.85 : 0;
  }
  
  // ── Working Memory Engagement Visualization ───────────────────────────────
  // Highlights regions actively engaged in working memory
  visualizeWorkingMemory(regionIds: BrainRegionId[], intensity: number = 1.0): void {
    // Create or update working memory highlight volume
    if (!this.workingMemoryGroup) {
      this.workingMemoryGroup = new THREE.Group();
      this.workingMemoryGroup.name = "WorkingMemoryGroup";
      this.group.add(this.workingMemoryGroup);
    } else {
      // Clear existing working memory volumes
      while (this.workingMemoryGroup.children.length > 0) {
        this.workingMemoryGroup.remove(this.workingMemoryGroup.children[0]);
      }
    }
    
    // Create a visual highlight for each working memory region
    for (const regionId of regionIds) {
      const region = REGION_BY_ID[regionId];
      if (!region) continue;
      
      // Create a glowing sphere for working memory engagement
      const geometry = new THREE.SphereGeometry(1.0, 32, 16);
      const material = new THREE.MeshStandardMaterial({
        color: 0x40a0ff,
        emissive: 0x40a0ff,
        emissiveIntensity: intensity * 0.7,
        transparent: true,
        opacity: 0.4 + intensity * 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        roughness: 0.2,
        metalness: 0.1
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(region.center[0], region.center[1], region.center[2]);
      mesh.scale.set(
        region.radius[0] * 1.2,
        region.radius[1] * 1.2,
        region.radius[2] * 1.2
      );
      
      // Add pulsing animation
      mesh.userData = {
        regionId,
        baseIntensity: intensity,
        animationPhase: Math.random() * Math.PI * 2
      };
      
      this.workingMemoryGroup.add(mesh);
    }
  }
  
  // Global storage for working memory group
  private workingMemoryGroup: THREE.Group | null = null;

  // Per-instance attribute geometry for the swapped neuron material (set by
  // applyVisualEffectsToGraph). Null until the material swap happens.
  private neuronAttrGeometry: THREE.BufferGeometry | null = null;
  // neuronType is fixed at connectome-build time; upload it once, not per frame.
  private neuronTypeUploaded = false;

  /** Attach the neuron InstancedMesh geometry whose instanced attributes the
   *  NEURON_VERT shader reads (membraneNorm/neuronType/burstStatus/memoryTrace). */
  attachNeuronGeometry(geometry: THREE.BufferGeometry): void {
    this.neuronAttrGeometry = geometry;
    this.neuronTypeUploaded = false; // re-upload type for the newly attached geometry
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private: post-processing
  // ══════════════════════════════════════════════════════════════════════════

  private initPostProcessing(): void {
    this.composer = new EffectComposer(new THREE.WebGLRenderer());
    this.neuromodPass = new ShaderPass(NEUROMOD_SHADER);
    this.filmGrainPass = new ShaderPass(FILM_GRAIN_SHADER);
    
    if (this.composer) {
      const renderPass = new RenderPass(new THREE.Scene(), new THREE.Camera());
      this.composer.addPass(renderPass);
      this.composer.addPass(this.neuromodPass);
      this.composer.addPass(this.filmGrainPass);
    }
  }

  attachToComposer(composer: EffectComposer, afterPass?: Pass): void {
    // Remove existing passes if they were added to another composer
    if (this.composer) {
      while (this.composer.passes.length > 0) {
        this.composer.removePass(this.composer.passes[0]);
      }
    }
    
    this.composer = composer;
    
    // Create passes if they don't exist
    if (!this.neuromodPass) {
      this.neuromodPass = new ShaderPass(NEUROMOD_SHADER);
    }
    if (!this.filmGrainPass) {
      this.filmGrainPass = new ShaderPass(FILM_GRAIN_SHADER);
    }
    
    // Add passes to composer
    if (!composer.passes.includes(this.neuromodPass)) {
      composer.addPass(this.neuromodPass);
    }
    if (!composer.passes.includes(this.filmGrainPass)) {
      composer.addPass(this.filmGrainPass);
    }
    
    // Set film grain resolution
    if (this.filmGrainPass) {
      const size = composer.renderer.getSize(new THREE.Vector2());
      this.filmGrainPass.uniforms.uResolution.value.set(size.width, size.height);
    }
    
    // Reorder passes if requested
    if (afterPass) {
      // This would require custom reordering logic based on the specific pass
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private: helpers
  // ══════════════════════════════════════════════════════════════════════════

  private computeGlobalActivity(regionIntensity: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < regionIntensity.length; i++) sum += regionIntensity[i];
    return Math.min(1, (sum / Math.max(1, regionIntensity.length)) * 2.0);
  }

  private averagePathwayActivity(pathwayIntensity: Float32Array): number {
    if (pathwayIntensity.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < pathwayIntensity.length; i++) sum += pathwayIntensity[i];
    return Math.min(1, sum / pathwayIntensity.length);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: upgrade existing NeuralGraphRenderer neuron/pathway materials.
// Call this from BrainScene after constructing NeuralGraphRenderer to give
// it the custom shader pipeline without rebuilding the graph.
// ─────────────────────────────────────────────────────────────────────────────
export function applyVisualEffectsToGraph(
  renderer: NeuralGraphRenderer,
  effects: BrainVisualEffects,
): void {
  const nm = effects.getNeuronMaterial();
  const pm = effects.getPathwayMaterial();

  // Swap neuron material (preserves instanceMatrix setup) and attach the
  // per-instance attributes NEURON_VERT reads (membraneNorm / neuronType /
  // burstStatus / memoryTrace), one float per neuron instance.
  const oldNeuron = (renderer as unknown as Record<string, unknown>).neuronMesh as THREE.InstancedMesh | undefined;
  if (oldNeuron) {
    // NOTE: this material swap is currently decorative-only — the swapped-in
    // membrane-heatmap ShaderMaterial does not visibly render (the neuron mesh's
    // draw fires once then stops; see docs/IMPROVEMENT_PLAN.md "neuronMesh membrane
    // path"). The live spiking visuals come from BrainVisualEffects.group
    // (RegionBreathing glow + PulseTrails + NeurotransmitterParticles), which ARE
    // driven by the (now stabilized) dynamics. Left in place pending that repair.
    oldNeuron.material = nm;
    const geo = oldNeuron.geometry;
    const count = oldNeuron.count;
    if (!geo.getAttribute("membraneNorm")) {
      for (const name of ["membraneNorm", "neuronType", "burstStatus", "memoryTrace"]) {
        geo.setAttribute(
          name,
          new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage),
        );
      }
    }
    // Phase 4 (improvement plan §1B): NEURON_VERT now reads `aScale`. The
    // renderer attaches it in shader mode; if it's missing (legacy renderer
    // upgraded mid-flight) default to 1.0 so existing visuals don't collapse.
    if (!geo.getAttribute("aScale")) {
      const aScale = new Float32Array(count);
      aScale.fill(1);
      geo.setAttribute(
        "aScale",
        new THREE.InstancedBufferAttribute(aScale, 1).setUsage(THREE.DynamicDrawUsage),
      );
    }
    effects.attachNeuronGeometry(geo);
  }

  // Swap pathway material
  const oldPathway = (renderer as unknown as Record<string, unknown>).pathwayLines as THREE.LineSegments | undefined;
  if (oldPathway) {
    oldPathway.material = pm;
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// BrainVisualEffectsRenderer — builds a secondary EffectComposer that renders
// after the main scene pass.  Use this when you want the visual effects to be
// rendered on top of (or integrated with) an existing BrainScene composer.
//
// Add the returned Group to your scene.  Call update() each frame.
// ─────────────────────────────────────────────────────────────────────────────
export class BrainVisualEffectsRenderer {
  readonly group = new THREE.Group();
  private readonly effects: BrainVisualEffects;
  private readonly bgPlane: THREE.Mesh;
  private readonly bgCamera: THREE.OrthographicCamera;
  private readonly bgScene: THREE.Scene;
  private readonly bgComposer: EffectComposer;
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly screenScene: THREE.Scene;
  private readonly screenCamera: THREE.OrthographicCamera;
  private readonly screenMesh: THREE.Mesh;
  private readonly screenComposer: EffectComposer;

  constructor(
    graph: NeuralGraph,
    simulation: BrainSimulation,
    width: number = 512,
    height: number = 512,
  ) {
    this.rt = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    this.effects = new BrainVisualEffects(graph, simulation, { useOwnComposer: false });

    // Background: renders the scene normally (for compositing against)
    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bgPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this.rt.texture }),
    );
    this.bgScene.add(this.bgPlane);

    this.bgComposer = new EffectComposer(new THREE.WebGLRenderer({ alpha: true }));
    this.bgComposer.setSize(width, height);
    this.bgComposer.addPass(new RenderPass(this.bgScene, this.bgCamera));

    // Screen quad: blends effects output on top
    this.screenScene = new THREE.Scene();
    this.screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.screenMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending }),
    );
    this.screenScene.add(this.screenMesh);

    this.screenComposer = new EffectComposer(new THREE.WebGLRenderer({ alpha: true, antialias: false }));
    this.screenComposer.setSize(width, height);
    this.screenComposer.addPass(new RenderPass(this.screenScene, this.screenCamera));

    this.group.add(this.screenMesh);
    this.screenMesh.renderOrder = 100;
  }

  update(
    elapsed: number,
    deltaSeconds: number,
    visibility: RegionVisibility,
    regionIntensity: Float32Array,
    pathwayIntensity: Float32Array,
  ): void {
    this.effects.update(elapsed, deltaSeconds, visibility, regionIntensity, pathwayIntensity);
  }

  updateMembranePotential(membraneNorm: Float32Array | null): void {
    this.effects.updateMembranePotential(membraneNorm);
  }

  setSize(width: number, height: number): void {
    this.rt.setSize(width, height);
    this.bgComposer.setSize(width, height);
    this.screenComposer.setSize(width, height);
    this.effects.setSize(width, height);
  }

  // Render the effects group into the RT, then composite to screen
  renderEffectsToTarget(
    mainScene: THREE.Scene,
    mainCamera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
  ): void {
    // 1. Render main scene to RT
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(mainScene, mainCamera);

    // 2. Update bg plane texture
    (this.bgPlane.material as THREE.MeshBasicMaterial).map = this.rt.texture;
    (this.bgPlane.material as THREE.MeshBasicMaterial).needsUpdate = true;

    // 3. Render effects group over RT background
    renderer.setRenderTarget(null);
    renderer.clear();

    // Draw the background scene (RT composite)
    this.bgComposer.render();

    // Draw the effects group on top with additive blending
    renderer.autoClear = false;
    const prevAutoClear = renderer.autoClearColor;
    renderer.autoClearColor = false;

    renderer.render(this.effects.group, mainCamera);

    renderer.autoClearColor = prevAutoClear;
    renderer.autoClear = true;
  }

  dispose(): void {
    this.rt.dispose();
    this.bgComposer.dispose();
    this.screenComposer.dispose();
    this.effects.dispose();
  }
}
