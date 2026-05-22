// MemorySystem.ts
// Neuroscience-inspired memory substrate for the BrainScene.
// Implements four major memory systems (working, episodic, semantic, procedural)
// with three plasticity mechanisms (STDP, homeostatic, neuromodulated),
// plus replay/consolidation dynamics.

import * as THREE from "three";
import { BrainRegionId, NeuralGraph, SynapticPathway, SignalPulse } from "./types";

// =============================================================================
// TYPES AND CONSTANTS
// =============================================================================

/**
 * Memory types and their primary neural substrates:
 * - Working memory:    Prefrontal cortex (PFC) – active maintenance of task-relevant info.
 * - Episodic memory:   Hippocampus → neocortex – context-rich autobiographical events.
 * - Semantic memory:   Anterior temporal lobe – abstracted factual knowledge.
 * - Procedural memory: Basal ganglia – skill learning and habits.
 */
export type MemoryType = "working" | "episodic" | "semantic" | "procedural";

/**
 * Neuromodulators that gate plasticity and memory consolidation:
 * - Dopamine (DA):    Reward prediction, salience, reinforcement of successful actions.
 * - Acetylcholine (ACh): Attentional focus, learning rate modulation.
 */
export type Neuromodulator = "dopamine" | "acetylcholine";

// Plasticity time constants (ms) from neurophysiology.
const TIME_CONSTANTS = {
  stdpWindow: 50, // Spike-timing window for STDP (ms)
  replayInterval: 2000, // Hippocampal replay rate (ms)
  consolidationInterval: 30000, // Systems consolidation period (ms)
  homeostaticInterval: 1000, // Homeostatic scaling interval (ms)
};

/**
 * Memory trace: a temporary record of neural activity in a given memory system.
 * Traces are created during encoding and decay over time unless consolidated.
 */
export interface MemoryTrace {
  id: string; // ULID
  type: MemoryType;
  regionId: BrainRegionId;
  neuronIds: number[]; // Indices into NeuralGraph.nodes
  pathwayIds: number[]; // Indices into NeuralGraph.pathways
  strength: number; // 0..1, synaptic weight proxy
  createdAt: number; // Timestamp (ms)
  lastAccessed: number;
  importance: number; // 0..1, modulates consolidation probability
  metadata: Record<string, unknown>; // e.g., source file, conversation context
}

/**
 * Hippocampal replay event: sequences of neural activations replayed during rest/sleep.
 */
export interface ReplayEvent {
  id: string;
  traceIds: string[]; // Episodic traces being replayed
  sequence: number[]; // Node IDs in replay order
  timestamp: number;
}

/**
 * Memory consolidation event: gradual transfer from hippocampus → neocortex.
 */
export interface ConsolidationEvent {
  sourceTraceId: string; // Episodic
  targetTraces: {
    traceId: string; // Semantic
    initialStrength: number;
    peakStrength: number;
  }[];
  timeline: { time: number; strength: number }[];
}

// =============================================================================
// MEMORY SYSTEM CORE
// =============================================================================

export class MemorySystem {
  // Memory state
  private traces: MemoryTrace[] = [];
  private replayBuffer: ReplayEvent[] = [];
  private consolidationQueue: ConsolidationEvent[] = [];
  private neuromodulators: Record<Neuromodulator, number> = {
    dopamine: 0.1, // Baseline tonic DA
    acetylcholine: 0.1, // Baseline tonic ACh
  };

  // Performance: offload consolidation to Web Workers
  private workerPool: Worker[] = [];

  // Visualization hooks
  private onTraceCreated?: (trace: MemoryTrace) => void;
  private onReplay?: (event: ReplayEvent) => void;
  private onConsolidation?: (event: ConsolidationEvent) => void;

  // Neuroscience parameters
  private stdpLearningRate = 0.01;
  private homeostaticLearningRate = 0.001;
  private replayProbability = 0.1; // Chance of replay per TIME_CONSTANTS.replayInterval

  constructor(private graph: NeuralGraph) {
    this.initializeWorkers();
    this.scheduleBackgroundProcesses();
  }

  // ===========================================================================
  // MEMORY ENCODING
  // ===========================================================================

  /**
   * Create a new memory trace from current neural activity.
   * @param type Memory system to encode into
   * @param regionId Primary brain region (e.g., "hippocampus-l" for episodic)
   * @param activeNeurons Array of neuron IDs showing spiking activity
   * @param activePathways Synaptic pathways active during encoding
   * @param metadata Contextual tags (e.g., conversation, file, action)
   */
  public encodeTrace(
    type: MemoryType,
    regionId: BrainRegionId,
    activeNeurons: number[],
    activePathways: number[],
    metadata: Record<string, unknown> = {}
  ): MemoryTrace {
    // Pattern separation: add noise to neuron selection to orthogonalize memories
    const neuronIds = this.applyPatternSeparation(activeNeurons);
    
    // Importance scoring: prioritize emotionally salient or task-relevant traces
    const importance = this.computeImportance(type, metadata);
    
    const trace: MemoryTrace = {
      id: this.generateULID(),
      type,
      regionId,
      neuronIds,
      pathwayIds: activePathways,
      strength: 0.5, // Initial strength
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      importance,
      metadata,
    };
    
    // Store and visualize
    this.traces.push(trace);
    this.onTraceCreated?.(trace);
    
    // Immediately apply STDP to pathways involved in encoding
    this.applySTDP(trace.pathwayIds);
    
    return trace;
  }

  /**
   * Pattern separation: modifies active neuron IDs to reduce overlap between similar memories.
   * Implemented via sparse random remapping (mimics dentate gyrus granule cells).
   */
  private applyPatternSeparation(neuronIds: number[]): number[] {
    const separatorMap: Record<number, number> = {};
    const density = 0.2; // Only 20% of neurons are eligible for remapping
    
    return neuronIds.map((id) => {
      if (Math.random() < density) {
        if (!separatorMap[id]) {
          // Find a nearby neuron in the same region (topological mapping)
          const node = this.graph.nodes[id];
          const candidates = this.graph.nodes.filter(
            (n) => n.regionId === node.regionId && n.id !== id
          );
          if (candidates.length > 0) {
            separatorMap[id] = candidates[Math.floor(Math.random() * candidates.length)].id;
          }
        }
        return separatorMap[id] || id;
      }
      return id;
    });
  }

  /**
   * Importance scoring: models neuromodulatory influence on memory strength.
   * Dopamine boosts importance for rewarded actions; ACh for attentional focus.
   */
  private computeImportance(type: MemoryType, metadata: Record<string, unknown>): number {
    let importance = 0.2; // Baseline
    
    // Task-relevance bonus
    if (metadata.action === "remember-event") importance += 0.3;
    
    // Emotional salience (simplified proxy via action type)
    if (type === "episodic" && metadata.emotion) {
      importance += 0.3;
    }
    
    // Neuromodulator influence
    importance *= 1 + this.neuromodulators.dopamine * 0.5;
    importance *= 1 + this.neuromodulators.acetycholine * 0.3;
    
    return Math.min(1, Math.max(0, importance));
  }

  // ===========================================================================
  // MEMORY RETRIEVAL
  // ===========================================================================

  /**
   * Retrieve traces matching recent neural activity.
   * Simulates pattern completion via partial cues.
   */
  public retrieveTraces(
    cueNeurons: number[],
    cuePathways: number[],
    typeFilter?: MemoryType[]
  ): MemoryTrace[] {
    const activeTraces = this.traces.filter((trace) => {
      if (typeFilter && !typeFilter.includes(trace.type)) return false;
      
      // Overlap score: Jaccard similarity between cue neurons and trace neurons
      const overlap = trace.neuronIds.filter((id) => cueNeurons.includes(id)).length;
      const jaccard = overlap / (trace.neuronIds.length + cueNeurons.length - overlap);
      
      // Pathway co-activation bonus
      const pathwayOverlap = trace.pathwayIds.filter((id) =>
        cuePathways.includes(id)
      ).length;
      
      return jaccard > 0.3 || pathwayOverlap > 0;
    });
    
    // Update access time and strenghten traces (spaced repetition effect)
    activeTraces.forEach((trace) => {
      trace.lastAccessed = Date.now();
      trace.strength = Math.min(1, trace.strength + 0.05);
    });
    
    return activeTraces;
  }

  // ===========================================================================
  // PLASTICITY MECHANISMS
  // ===========================================================================

  /**
   * Spike-Timing Dependent Plasticity (STDP): adjusts synaptic weights based on
   * temporal order of pre- and post-synaptic spikes.
   * - Pre → Post: Long-Term Potentiation (LTP)
   * - Post → Pre: Long-Term Depression (LTD)
   */
  private applySTDP(pathwayIds: number[]): void {
    pathwayIds.forEach((id) => {
      const pathway = this.graph.pathways[id];
      if (!pathway) return;
      
      // Simplified STDP: pathways active during encoding get LTP
      pathway.strength = Math.min(1, pathway.strength + this.stdpLearningRate);
    });
  }

  /**
   * Homeostatic plasticity: maintains network stability by scaling synaptic weights.
   * Prevents runaway excitation or quiescence.
   */
  private applyHomeostaticPlasticity(): void {
    this.graph.pathways.forEach((pathway) => {
      // Scale weights toward mean activity level
      const target = 0.5;
      pathway.strength = 
        pathway.strength +
        this.homeostaticLearningRate * (target - pathway.strength);
    });
  }

  /**
   * Neuromodulated plasticity: dopamine/ACh gate learning rates and consolidation.
   */
  public updateNeuromodulators(updates: Partial<Record<Neuromodulator, number>>): void {
    Object.entries(updates).forEach(([key, value]) => {
      if (key in this.neuromodulators) {
        this.neuromodulators[key as Neuromodulator] = Math.min(
          1,
          Math.max(0, value)
        );
      }
    });
  }

  // ===========================================================================
  // CONSOLIDATION AND REPLAY
  // ===========================================================================

  /**
   * Hippocampal replay: spontaneous reactivation of recent episodic traces.
   * Occurs during rest/sleep. Critical for systems consolidation.
   */
  private generateReplayEvent(): ReplayEvent | null {
    const episodicTraces = this.traces.filter((t) => t.type === "episodic");
    if (episodicTraces.length === 0) return null;
    
    // Sample a trace biased by importance and recency
    const weights = episodicTraces.map(
      (t) => t.importance ** 2 * Math.exp((t.lastAccessed - Date.now()) / (1000 * 60 * 60))
    );
    const trace =
      episodicTraces[this.weightedRandomSample(weights)];
    
    // Generate replay sequence (simplified: random walk on trace neurons)
    const sequence = [trace.neuronIds[0]];
    for (let i = 1; i < trace.neuronIds.length; i++) {
      if (Math.random() < 0.7) {
        // Follow a pathway
        const lastNode = sequence[i - 1];
        const candidates = this.graph.pathways.filter(
          (p) => p.source === lastNode && trace.neuronIds.includes(p.target)
        );
        if (candidates.length > 0) {
          sequence.push(candidates[0].target);
        }
      } else {
        sequence.push(trace.neuronIds[i]);
      }
    }
    
    const event = {
      id: this.generateULID(),
      traceIds: [trace.id],
      sequence,
      timestamp: Date.now(),
    };
    
    this.replayBuffer.push(event);
    this.onReplay?.(event);
    return event;
  }

  /**
   * Systems consolidation: gradual transfer from hippocampus → neocortex.
   * Hippocampal replay drives neocortical plasticity via NMDA-dependent LTP.
   */
  private consolidateMemory(replayEvent: ReplayEvent): void {
    const sourceTrace = this.traces.find(
      (t) => replayEvent.traceIds[0] === t.id
    );
    if (!sourceTrace || sourceTrace.type !== "episodic") return;
    
    // Create or strengthen semantic traces
    const semanticNeurons = this.extractSemanticNeurons(sourceTrace);
    const semanticPathways = this.extractSemanticPathways(
      sourceTrace,
      semanticNeurons
    );
    
    // Pattern completion: retrieve related semantic traces
    const relatedTraces = this.retrieveTraces(
      semanticNeurons,
      semanticPathways,
      ["semantic"]
    );
    
    let targetTrace: MemoryTrace;
    if (relatedTraces.length > 0) {
      // Strengthen existing semantic trace
      targetTrace = relatedTraces[0];
      targetTrace.strength = Math.min(1, targetTrace.strength + 0.1);
      targetTrace.lastAccessed = Date.now();
    } else {
      // Create new semantic trace
      targetTrace = this.encodeTrace(
        "semantic",
        sourceTrace.regionId.replace("hippocampus", "temporal"), // Remap to temporal lobe
        semanticNeurons,
        semanticPathways,
        {
          derivedFrom: sourceTrace.id,
          ...sourceTrace.metadata,
        }
      );
    }
    
    // Track consolidation timeline
    const consolidationEvent: ConsolidationEvent = {
      sourceTraceId: sourceTrace.id,
      targetTraces: [
        {
          traceId: targetTrace.id,
          initialStrength: targetTrace.strength,
          peakStrength: targetTrace.strength,
        },
      ],
      timeline: [{ time: Date.now(), strength: targetTrace.strength }],
    };
    
    this.consolidationQueue.push(consolidationEvent);
    this.onConsolidation?.(consolidationEvent);
  }

  /**
   * Extract semantic neurons: identifies high-degree nodes in episodic trace.
   * Simulates neocortical abstraction process.
   */
  private extractSemanticNeurons(trace: MemoryTrace): number[] {
    // Simple heuristic: most frequent nodes in pathway targets
    const frequency: Record<number, number> = {};
    trace.pathwayIds.forEach((id) => {
      const pathway = this.graph.pathways[id];
      frequency[pathway.target] = (frequency[pathway.target] || 0) + 1;
    });
    
    return Object.entries(frequency)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => parseInt(id))
      .slice(0, 10); // Top 10 most connected
  }

  /**
   * Extract semantic pathways: connects semantic neurons in trace.
   */
  private extractSemanticPathways(
    trace: MemoryTrace,
    semanticNeurons: number[]
  ): number[] {
    return trace.pathwayIds.filter((id) => {
      const pathway = this.graph.pathways[id];
      return (
        semanticNeurons.includes(pathway.source) &&
        semanticNeurons.includes(pathway.target)
      );
    });
  }

  // ===========================================================================
  // BACKGROUND PROCESSES
  // ===========================================================================

  /**
   * Schedule background processes: replay, consolidation, and homeostatic scaling.
   */
  private scheduleBackgroundProcesses(): void {
    // Hippocampal replay
    setInterval(() => {
      if (Math.random() < this.replayProbability) {
        const event = this.generateReplayEvent();
        if (event) this.consolidateMemory(event);
      }
    }, TIME_CONSTANTS.replayInterval);
    
    // Systems consolidation
    setInterval(() => {
      if (this.consolidationQueue.length > 0) {
        this.processConsolidationQueue();
      }
    }, TIME_CONSTANTS.consolidationInterval);
    
    // Homeostatic plasticity
    setInterval(() => {
      this.applyHomeostaticPlasticity();
    }, TIME_CONSTANTS.homeostaticInterval);
  }

  /**
   * Offload consolidation to Web Workers for performance.
   */
  private initializeWorkers(): void {
    if (typeof Worker !== "undefined") {
      const workerCount = navigator.hardwareConcurrency || 2;
      for (let i = 0; i < workerCount; i++) {
        const worker = new Worker(
          URL.createObjectURL(
            new Blob([`
              self.onmessage = function(e) {
                // Simplified consolidation logic for worker
                const { timeline } = e.data;
                for (let i = 1; i < timeline.length; i++) {
                  timeline[i].strength = Math.min(
                    1,
                    timeline[i-1].strength + 0.01
                  );
                }
                postMessage(timeline);
              };
            `]),
            { type: "text/javascript" }
          )
        );
        worker.onmessage = (e) => {
          const event = this.consolidationQueue.find(
            (ev) => ev.timeline === e.data
          );
          if (event) {
            event.timeline = e.data;
            event.targetTraces[0].peakStrength = e.data[e.data.length - 1].strength;
          }
        };
        this.workerPool.push(worker);
      }
    }
  }

  /**
   * Process consolidation queue in parallel.
   */
  private processConsolidationQueue(): void {
    this.consolidationQueue.forEach((event, index) => {
      if (this.workerPool.length > 0) {
        const worker = this.workerPool[index % this.workerPool.length];
        worker.postMessage({
          timeline: event.timeline,
        });
      } else {
        // Fallback: process in main thread
        event.timeline.push({
          time: Date.now(),
          strength: Math.min(
            1,
            event.timeline[event.timeline.length - 1].strength + 0.01
          ),
        });
        event.targetTraces[0].peakStrength =
          event.timeline[event.timeline.length - 1].strength;
      }
    });
  }

  // ===========================================================================
  // INTEGRATION HOOKS
  // ===========================================================================

  /**
   * Hook for Izhikevich neuron simulation: inject memory-driven membrane potential.
   */
  public getMemoryPotentials(neuronIds: number[]): Float32Array {
    const potentials = new Float32Array(neuronIds.length).fill(0);
    this.traces.forEach((trace) => {
      trace.neuronIds.forEach((id, idx) => {
        const neuronIdx = neuronIds.indexOf(id);
        if (neuronIdx >= 0) {
          potentials[neuronIdx] += trace.strength * 0.2; // Scale influence
        }
      });
    });
    return potentials;
  }

  /**
   * Connectome integration: add memory-specific pathways.
   */
  public getMemoryPathways(): SynapticPathway[] {
    // Simplified: return all pathways from episodic/semantic traces
    return this.traces
      .filter((t) => t.type === "episodic" || t.type === "semantic")
      .flatMap((t) => t.pathwayIds)
      .map((id) => this.graph.pathways[id])
      .filter(Boolean);
  }

  /**
   * Sensory input integration: tag memories with sensory context.
   */
  public tagWithSensoryContext(
    traceId: string,
    sensoryData: Record<string, unknown>
  ): void {
    const trace = this.traces.find((t) => t.id === traceId);
    if (trace) {
      trace.metadata.sensoryContext = {
        ...trace.metadata.sensoryContext,
        ...sensoryData,
      };
    }
  }

  // ===========================================================================
  // VISUALIZATION HELPERS
  // ===========================================================================

  /**
   * Generate THREE.js meshes for memory traces.
   */
  public createTraceMeshes(): THREE.Group {
    const group = new THREE.Group();
    
    this.traces.forEach((trace) => {
      // Color by memory type
      const color = new THREE.Color(
        trace.type === "working"
          ? 0xff0000
          : trace.type === "episodic"
          ? 0x00ff00
          : trace.type === "semantic"
          ? 0x0000ff
          : 0xffff00
      );
      
      // Create spheres for neurons
      trace.neuronIds.forEach((id) => {
        const node = this.graph.nodes[id];
        const geometry = new THREE.SphereGeometry(node.size * 0.5);
        const material = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: trace.strength,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.fromArray(node.position);
        group.add(mesh);
      });
      
      // Create tubes for pathways
      trace.pathwayIds.forEach((id) => {
        const pathway = this.graph.pathways[id];
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3().fromArray(this.graph.nodes[pathway.source].position),
          new THREE.Vector3().fromArray(pathway.controlPoint),
          new THREE.Vector3().fromArray(this.graph.nodes[pathway.target].position),
        ]);
        const geometry = new THREE.TubeGeometry(curve, 16, pathway.strength * 0.1);
        const material = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: trace.strength,
        });
        const mesh = new THREE.Mesh(geometry, material);
        group.add(mesh);
      });
    });
    
    return group;
  }

  /**
   * Highlight neurons involved in replay.
   */
  public highlightReplay(replayEvent: ReplayEvent, duration = 2000): void {
    const startTime = Date.now();
    const originalColors: Record<number, THREE.Color> = {};
    
    // Set up animation loop
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      
      replayEvent.sequence.forEach((nodeId, idx) => {
        const node = this.graph.nodes[nodeId];
        if (node) {
          // Create a pulsing effect
          const pulse = Math.sin(progress * Math.PI * 4) * 0.5 + 0.5;
          const intensity = 0.5 + pulse * 0.5;
          // In a real implementation, update shader uniforms here
        }
      });
      
      if (progress < 1) requestAnimationFrame(animate);
    };
    
    animate();
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  /**
   * Weighted random sample from array.
   */
  private weightedRandomSample(weights: number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    const threshold = Math.random() * total;
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i];
      if (sum >= threshold) return i;
    }
    return weights.length - 1;
  }

  /**
   * Generate ULID (Universally Unique Lexicographically Sortable Identifier).
   */
  private generateULID(): string {
    const chars =
      "0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz";
    const timestamp = Date.now().toString(36).padStart(10, "0");
    const random = Array.from({ length: 16 })
      .map(() => chars[Math.floor(Math.random() * chars.length)])
      .join("");
    return timestamp + random;
  }
}

// =============================================================================
// NEUROSCIENCE REFERENCE
// =============================================================================
/*
## Memory Systems

1. **Working Memory**
   - Function: Active maintenance of task-relevant information (Baddeley & Hitch, 1974).
   - Neural substrate: Dorsolateral prefrontal cortex (dlPFC) and fronto-parietal network.
   - Mechanism: Reverberatory loops and persistent neural firing (Goldman-Rakic, 1995).

2. **Episodic Memory**
   - Function: Context-rich autobiographical events (Tulving, 1972).
   - Neural substrate: Hippocampus and surrounding medial temporal lobe.
   - Mechanism: Pattern separation in DG → CA3 autoassociation → CA1 pattern completion.

3. **Semantic Memory**
   - Function: Abstracted factual knowledge (e.g., "Paris is the capital of France").
   - Neural substrate: Anterior temporal lobe (Patterson et al., 2007).
   - Mechanism: Convergence zones that bind distributed neocortical representations.

4. **Procedural Memory**
   - Function: Skill learning and habits (e.g., riding a bike).
   - Neural substrate: Basal ganglia (striatum) and cerebellum.
   - Mechanism: Slow accumulation of stimulus-response associations.

## Plasticity Mechanisms

1. **Spike-Timing Dependent Plasticity (STDP)**
   - Hebbian learning rule adjusted by spike timing (Bi & Poo, 1998).
   - Pre → Post (Δt > 0): Long-Term Potentiation (LTP).
   - Post → Pre (Δt < 0): Long-Term Depression (LTD).
   - Implementation: Pathway strength += η * exp(-|Δt|/τ).

2. **Homeostatic Plasticity**
   - Function: Stabilize network activity by scaling synaptic strengths (Turrigiano & Nelson, 2004).
   - Mechanism: Synaptic weights are adjusted toward a target firing rate.

3. **Neuromodulated Plasticity**
   - Dopamine: Signals reward prediction error (Schultz et al., 1997). Modulates LTP/LTD.
   - Acetylcholine: Enhances sensory processing and learning rates (Hasselmo, 2006).
   - Implementation: Plasticity rates are multiplied by neuromodulator concentration.

## Consolidation Dynamics

- **Hippocampal Replay**: Reactivation of recent experiences during sharp-wave ripples (Wilson & McNaughton, 1994).
  - Occurs during rest/sleep.
  - Temporally compressed (6–12x faster than real time).
  - Biases toward high-importance or rewarded events.

- **Systems Consolidation**: Gradual transfer from hippocampus → neocortex (McClelland et al., 1995).
  - Mechanism: Hippocampal replay drives neocortical plasticity.
  - Timeline: Weeks–months depending on memory salience.
  - Result: Semantic abstraction of episodic memories.

- **Vital Importance Signals**:
  - Prediction error (DA) → boosts consolidation of valuable memories.
  - Emotional arousal (NE) → enhances memory strength (McGaugh, 2013).
*/