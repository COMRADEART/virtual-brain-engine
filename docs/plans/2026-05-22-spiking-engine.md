# SpikingEngine Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace `SignalSimulation` with a biologically realistic spiking neural network (`SpikingEngine`) using Leaky Integrate-and-Fire (LIF) neurons, neuromodulation, and theta-gamma oscillations.

**Architecture:**
- **Neuron Model:** Leaky Integrate-and-Fire (LIF) with synaptic conductances (AMPA, NMDA).
- **Plasticity:** Spike-Timing-Dependent Plasticity (STDP) modulated by dopamine/acetylcholine.
- **Oscillations:** Theta (5-10 Hz) and Gamma (30-100 Hz) rhythms via Kuramoto model.
- **Memory Replay:** Hippocampal ripples and neocortical replay during consolidation.
- **Performance:** Float32Arrays for state, vectorized updates.

**Tech Stack:**
- TypeScript
- THREE.js (for visualization)
- Float32Arrays (for performance)
- Web Workers (future-proofing)

---


### Task 1: Create `SpikingEngine.ts` Skeleton

**Objective:** Set up the basic structure of `SpikingEngine.ts` with core interfaces and constants.

**Files:**
- Create: `src/engine/SpikingEngine.ts`

**Step 1: Define core interfaces and constants**
```typescript
// src/engine/SpikingEngine.ts
import type {
  BrainActionId,
  BrainRegionId,
  NeuralGraph,
  SignalPulse,
  BrainSimulation,
} from "./types";
import { REGION_INDEX } from "./brainRegions";
import { LOGICAL_REGION_MAP } from "./logicalRegions";

// Neuromodulator types
type Neuromodulator = "dopamine" | "acetylcholine" | "serotonin" | "norepinephrine";

// Synaptic conductance types
type SynapseType = "AMPA" | "NMDA";

// Neuron types
interface LIFNeuron {
  id: number;
  regionId: BrainRegionId;
  regionIndex: number;
  membranePotential: number;
  lastSpikeTime: number;
  refractoryPeriod: number;
  synapses: Synapse[];
}

interface Synapse {
  targetNeuronId: number;
  weight: number;
  type: SynapseType;
  conductance: number;
  decayRate: number;
}

// Oscillation phases
interface OscillationState {
  thetaPhase: number; // Radians
  gammaPhase: number; // Radians
  thetaFrequency: number; // Hz
  gammaFrequency: number; // Hz
}

// Memory replay state
interface ReplayState {
  replaying: boolean;
  replayStartTime: number;
  replayDuration: number;
  replayPathways: number[];
}

// Constants
const NEURON_PARAMS = {
  restingPotential: -70, // mV
  thresholdPotential: -55, // mV
  resetPotential: -80, // mV
  membraneTimeConstant: 10, // ms
  refractoryPeriod: 5, // ms
  leakConductance: 0.1, // nS
};

const SYNAPSE_PARAMS = {
  AMPA: { riseTime: 1, decayTime: 5, reversalPotential: 0 },
  NMDA: { riseTime: 10, decayTime: 100, reversalPotential: 0 },
};

const OSCILLATION_PARAMS = {
  thetaFrequency: 7, // Hz
  gammaFrequency: 40, // Hz
};

export class SpikingEngine implements BrainSimulation {
  private graph: NeuralGraph;
  private actionId: BrainActionId;
  private running: boolean;
  private speed: number;
  private readonly neurons: LIFNeuron[];
  private readonly oscillationState: OscillationState;
  private readonly replayState: ReplayState;
  private neuromodulators: Record<Neuromodulator, number>;

  readonly regionIntensity: Float32Array;
  readonly regionFlashIntensity: Float32Array;
  readonly pathwayIntensity: Float32Array;
  readonly pulses: SignalPulse[];
  readonly memoryIntensity: number;
  readonly membranePotentialNorm: Float32Array;
  readonly dopamine: number;
  readonly acetylcholine: number;
  readonly thetaPhase: number;
  readonly gammaPhase: number;

  constructor(graph: NeuralGraph, actionId: BrainActionId) {
    this.graph = graph;
    this.actionId = actionId;
    this.running = true;
    this.speed = 1;
    this.neurons = [];
    this.oscillationState = {
      thetaPhase: 0,
      gammaPhase: 0,
      thetaFrequency: OSCILLATION_PARAMS.thetaFrequency,
      gammaFrequency: OSCILLATION_PARAMS.gammaFrequency,
    };
    this.replayState = {
      replaying: false,
      replayStartTime: 0,
      replayDuration: 0,
      replayPathways: [],
    };
    this.neuromodulators = {
      dopamine: 0.3,
      acetylcholine: 0.4,
      serotonin: 0.2,
      norepinephrine: 0.1,
    };

    // Initialize arrays
    this.regionIntensity = new Float32Array(graph.regionOrder.length);
    this.regionFlashIntensity = new Float32Array(graph.regionOrder.length);
    this.pathwayIntensity = new Float32Array(graph.pathways.length);
    this.membranePotentialNorm = new Float32Array(graph.nodes.length);
    this.pulses = [];
    this.memoryIntensity = 0;
  }

  // Interface methods
  setGraph(graph: NeuralGraph): void {}
  setAction(actionId: BrainActionId): void {}
  setRunning(running: boolean): void {}
  setSpeed(speed: number): void {}
  setMaxPulses(maxPulses: number): void {}
  setMemoryIntensity(intensity: number): void {}
  flashRegions(regionIds: BrainRegionId[], magnitude?: number): void {}
  flashLogicalRegion(id: string, magnitude?: number): void {}
  step(deltaSeconds: number, elapsedSeconds: number): void {}
  triggerMemoryReplay(): void {}
}
```

**Step 2: Verify file creation**
Run:
```bash
Test-Path -LiteralPath "src/engine/SpikingEngine.ts"
```
Expected: `True`

**Step 3: Commit**
```bash
git add src/engine/SpikingEngine.ts
git commit -m "feat(spiking-engine): add SpikingEngine.ts skeleton with core interfaces"
```

---

### Task 2: Implement Neuron Initialization

**Objective:** Initialize LIF neurons from the `NeuralGraph` and set up synaptic connections.

**Files:**
- Modify: `src/engine/SpikingEngine.ts`

**Step 1: Add neuron initialization logic**
```typescript
// Add to SpikingEngine class
private initializeNeurons(): void {
  this.neurons.length = 0;

  // Create neurons from graph nodes
  for (const node of this.graph.nodes) {
    this.neurons.push({
      id: node.id,
      regionId: node.regionId,
      regionIndex: node.regionIndex,
      membranePotential: NEURON_PARAMS.restingPotential,
      lastSpikeTime: -Infinity,
      refractoryPeriod: NEURON_PARAMS.refractoryPeriod,
      synapses: [],
    });
  }

  // Create synapses from pathways
  for (const pathway of this.graph.pathways) {
    const sourceNeuron = this.neurons[pathway.source];
    const targetNeuron = this.neurons[pathway.target];
    if (!sourceNeuron || !targetNeuron) continue;

    // Add AMPA synapse
    sourceNeuron.synapses.push({
      targetNeuronId: pathway.target,
      weight: pathway.strength * 0.7,
      type: "AMPA",
      conductance: 0,
      decayRate: 1 / SYNAPSE_PARAMS.AMPA.decayTime,
    });

    // Add NMDA synapse for plastic pathways
    if (pathway.strength > 0.5) {
      sourceNeuron.synapses.push({
        targetNeuronId: pathway.target,
        weight: pathway.strength * 0.3,
        type: "NMDA",
        conductance: 0,
        decayRate: 1 / SYNAPSE_PARAMS.NMDA.decayTime,
      });
    }
  }
}

// Call in constructor
constructor(graph: NeuralGraph, actionId: BrainActionId) {
  // ... existing code ...
  this.initializeNeurons();
}
```

**Step 2: Verify initialization**
Run:
```bash
# Check neuron count matches graph nodes
node -e "
  const fs = require('fs');
  const content = fs.readFileSync('src/engine/SpikingEngine.ts', 'utf8');
  const neuronCount = (content.match(/this\.neurons\.push\(\{/g) || []).length;
  const nodeCount = require('./src/engine/types.ts').NeuralGraph.nodes.length;
  console.log('Neuron:', neuronCount, 'Node:', nodeCount, 'Match:', neuronCount === nodeCount);
"
```
Expected: `Neuron: 10000 Node: 10000 Match: true` (adjust based on graph)

**Step 3: Commit**
```bash
git add src/engine/SpikingEngine.ts
git commit -m "feat(spiking-engine): implement neuron initialization and synaptic connections"
```

---

### Task 3: Implement LIF Neuron Dynamics

**Objective:** Add membrane potential updates, spiking, and refractory periods.

**Files:**
- Modify: `src/engine/SpikingEngine.ts`

**Step 1: Add LIF dynamics**
```typescript
// Add to SpikingEngine class
private updateNeuron(neuron: LIFNeuron, deltaMs: number): void {
  // Skip if in refractory period
  if (neuron.lastSpikeTime + NEURON_PARAMS.refractoryPeriod > performance.now()) {
    return;
  }

  // Calculate synaptic input
  let synapticInput = 0;
  for (const synapse of neuron.synapses) {
    // Update conductance decay
    synapse.conductance *= Math.exp(-synapse.decayRate * deltaMs);
    synapticInput += synapse.conductance * synapse.weight * SYNAPSE_PARAMS[synapse.type].reversalPotential;
  }

  // Leaky integrate-and-fire dynamics
  const leakCurrent = NEURON_PARAMS.leakConductance * (neuron.membranePotential - NEURON_PARAMS.restingPotential);
  const voltageChange = (-leakCurrent + synapticInput) / NEURON_PARAMS.membraneTimeConstant * deltaMs;
  neuron.membranePotential += voltageChange;

  // Check for spike
  if (neuron.membranePotential >= NEURON_PARAMS.thresholdPotential) {
    neuron.membranePotential = NEURON_PARAMS.resetPotential;
    neuron.lastSpikeTime = performance.now();
    this.handleSpike(neuron);
  }
}

private handleSpike(neuron: LIFNeuron): void {
  // Propagate spike to postsynaptic neurons
  for (const synapse of neuron.synapses) {
    const targetNeuron = this.neurons[synapse.targetNeuronId];
    if (!targetNeuron) continue;

    // Update synaptic conductance
    synapse.conductance += 1;

    // Trigger pulse for visualization
    this.spawnPulse(neuron.id, synapse.targetNeuronId, synapse.weight);
  }

  // Update region intensity
  this.regionIntensity[neuron.regionIndex] = Math.min(
    1.0,
    this.regionIntensity[neuron.regionIndex] + 0.1
  );
}
```

**Step 2: Add neuron update loop**
```typescript
// Update step method
step(deltaSeconds: number, elapsedSeconds: number): void {
  if (!this.running) return;

  const deltaMs = deltaSeconds * 1000;

  // Update all neurons
  for (const neuron of this.neurons) {
    this.updateNeuron(neuron, deltaMs);
  }

  // Update membrane potential for visualization
  for (let i = 0; i < this.neurons.length; i++) {
    const neuron = this.neurons[i];
    // Normalize membrane potential to [0, 1] for visualization
    this.membranePotentialNorm[i] = Math.min(
      1.0,
      Math.max(0.0, (neuron.membranePotential - NEURON_PARAMS.restingPotential) / 
        (NEURON_PARAMS.thresholdPotential - NEURON_PARAMS.restingPotential))
    );
  }

  // Update oscillation phases
  this.updateOscillations(deltaMs);
}
```

**Step 3: Verify spikes**
Add temporary debug code:
```typescript
// Add to handleSpike
console.log(`Spike from neuron ${neuron.id} in region ${neuron.regionId}`);

// Add to step method
if (elapsedSeconds % 1 < deltaSeconds) {
  console.log(`Step: ${elapsedSeconds.toFixed(2)}s, Theta: ${this.oscillationState.thetaPhase.toFixed(2)}`);
}
```

Run the app (`npm run dev`) and check console for spikes.

**Step 4: Commit**
```bash
git add src/engine/SpikingEngine.ts
git commit -m "feat(spiking-engine): implement LIF neuron dynamics and spiking"
```

---

### Task 4: Implement Theta-Gamma Oscillations

**Objective:** Add Kuramoto model for theta (hippocampus) and gamma (neocortex) oscillations.

**Files:**
- Modify: `src/engine/SpikingEngine.ts`

**Step 1: Add oscillation update**
```typescript
// Add to SpikingEngine class
private updateOscillations(deltaMs: number): void {
  // Update theta phase (hippocampus)
  this.oscillationState.thetaPhase += 
    2 * Math.PI * this.oscillationState.thetaFrequency * (deltaMs / 1000);
  this.oscillationState.thetaPhase %= 2 * Math.PI;

  // Update gamma phase (neocortex)
  this.oscillationState.gammaPhase += 
    2 * Math.PI * this.oscillationState.gammaFrequency * (deltaMs / 1000);
  this.oscillationState.gammaPhase %= 2 * Math.PI;
}

// Add getters for external access
get thetaPhase(): number {
  return this.oscillationState.thetaPhase;
}

get gammaPhase(): number {
  return this.oscillationState.gammaPhase;
}
```

**Step 2: Add phase-based modulation**
```typescript
// Update updateNeuron method
private updateNeuron(neuron: LIFNeuron, deltaMs: number): void {
  // Skip if in refractory period
  if (neuron.lastSpikeTime + NEURON_PARAMS.refractoryPeriod > performance.now()) {
    return;
  }

  // Phase-based excitability modulation
  const phase = neuron.regionId.startsWith("hippocampus")
    ? this.oscillationState.thetaPhase
    : this.oscillationState.gammaPhase;
  const excitabilityBoost = 0.2 * Math.sin(phase);

  // Calculate synaptic input
  let synapticInput = 0;
  for (const synapse of neuron.synapses) {
    // Update conductance decay
    synapse.conductance *= Math.exp(-synapse.decayRate * deltaMs);
    synapticInput += synapse.conductance * synapse.weight * 
      SYNAPSE_PARAMS[synapse.type].reversalPotential * (1 + excitabilityBoost);
  }

  // ... rest of the method ...
}
```

**Step 3: Verify oscillations**
Add debug logging:
```typescript
// In step method
console.log(`Theta: ${this.oscillationState.thetaPhase.toFixed(2)}, `
  + `Gamma: ${this.oscillationState.gammaPhase.toFixed(2)}`);
```

Run the app and check console for phase progression.

**Step 4: Commit**
```bash
git add src/engine/SpikingEngine.ts
git commit -m "feat(spiking-engine): implement theta-gamma oscillations and phase-based modulation"
```

---

### Task 5: Implement Neuromodulation

**Objective:** Add dopamine and acetylcholine modulation of synaptic plasticity.

**Files:**
- Modify: `src/engine/SpikingEngine.ts`

**Step 1: Add STDP (Spike-Timing-Dependent Plasticity)**
```typescript
// Add to SpikingEngine class
private applySTDP(preNeuronId: number, postNeuronId: number): void {
  const preNeuron = this.neurons[preNeuronId];
  const postNeuron = this.neurons[postNeuronId];
  if (!preNeuron || !postNeuron) return;

  // Find synapses from pre to post
  for (const synapse of preNeuron.synapses) {
    if (synapse.targetNeuronId === postNeuronId) {
      // Calculate timing difference (simplified)
      const timingDiff = preNeuron.lastSpikeTime - postNeuron.lastSpikeTime;

      // STDP learning window
      let weightChange = 0;
      if (timingDiff > 0 && timingDiff < 20) {
        // Pre before post: LTP (potentiation)
        weightChange = 0.01 * Math.exp(-timingDiff / 10);
      } else if (timingDiff < 0 && timingDiff > -20) {
        // Post before pre: LTD (depression)
        weightChange = -0.01 * Math.exp(timingDiff / 10);
      }

      // Apply neuromodulation
      weightChange *= this.neuromodulators.dopamine; // Reward-driven plasticity
      weightChange *= this.neuromodulators.acetylcholine; // Memory consolidation

      // Update weight with bounds
      synapse.weight = Math.min(1.0, Math.max(0.0, synapse.weight + weightChange));
    }
  }
}

// Update handleSpike
private handleSpike(neuron: LIFNeuron): void {
  // Propagate spike to postsynaptic neurons
  for (const synapse of neuron.synapses) {
    const targetNeuron = this.neurons[synapse.targetNeuronId];
    if (!targetNeuron) continue;

    // Update synaptic conductance
    synapse.conductance += 1;

    // Apply STDP
    this.applySTDP(neuron.id, synapse.targetNeuronId);

    // Trigger pulse for visualization
    this.spawnPulse(neuron.id, synapse.targetNeuronId, synapse.weight);
  }

  // ... rest of method ...
}
```

**Step 2: Add neuromodulator getters/setters**
```typescript
// Add getters
get dopamine(): number {
  return this.neuromodulators.dopamine;
}

get acetylcholine(): number {
  return this.neuromodulators.acetylcholine;
}

// Add setters
setDopamine(level: number): void {
  this.neuromodulators.dopamine = Math.min(1.0, Math.max(0.0, level));
}

setAcetylcholine(level: number): void {
  this.neuromodulators.acetylcholine = Math.min(1.0, Math.max(0.0, level));
}
```

**Step 3: Verify plasticity**
Add debug logging:
```typescript
// In applySTDP
console.log(`STDP: pre=${preNeuronId}, post=${postNeuronId}, `
  + `change=${weightChange.toFixed(4)}, newWeight=${synapse.weight.toFixed(4)}`);
```

Run the app and check console for weight changes.\n
**Step 4: Commit**
```bash
git add src/engine/SpikingEngine.ts
git commit -m "feat(spiking-engine): implement neuromodulation and STDP"
```

---

### Task 6: Implement Memory Replay

**Objective:** Add hippocampal ripple replay and neocortical consolidation.

**Files:**
- Modify: `src/engine/SpikingEngine.ts`

**Step 1: Add replay trigger**
```typescript
// Add to SpikingEngine class
triggerMemoryReplay(duration: number = 2.0): void {
  this.replayState.replaying = true;
  this.replayState.replayStartTime = performance.now();
  this.replayState.replayDuration = duration;
  this.replayState.replayPathways = [];

  // Select pathways for replay (prioritize hippocampus and neocortex)
  for (let i = 0; i < this.graph.pathways.length; i++) {
    const pathway = this.graph.pathways[i];
    if (pathway.sourceRegionId.startsWith("hippocampus") ||
        pathway.targetRegionId.startsWith("hippocampus")) {
      this.replayState.replayPathways.push(i);
    }
  }

  console.log(`Memory replay triggered: ${this.replayState.replayPathways.length} pathways`);
}
```

**Step 2: Add replay dynamics**
```typescript
// Update step method
step(deltaSeconds: number, elapsedSeconds: number): void {
  if (!this.running) return;

  const deltaMs = deltaSeconds * 1000;

  // Handle memory replay
  this.handleMemoryReplay(deltaMs);

  // Update all neurons
  for (const neuron of this.neurons) {
    this.updateNeuron(neuron, deltaMs);
  }

  // ... rest of method ...
}

private handleMemoryReplay(deltaMs: number): void {
  if (!this.replayState.replaying) return;

  const replayProgress = (performance.now() - this.replayState.replayStartTime) / 
    (this.replayState.replayDuration * 1000);

  if (replayProgress >= 1.0) {
    this.replayState.replaying = false;
    console.log("Memory replay completed");
    return;
  }

  // Simulate ripple-like activity in hippocampus
  if (this.oscillationState.thetaPhase < 0.1) { // Theta peak
    for (const pathwayIndex of this.replayState.replayPathways) {
      const pathway = this.graph.pathways[pathwayIndex];
      if (pathway.sourceRegionId.startsWith("hippocampus")) {
        // Boost synaptic conductance
        const sourceNeuron = this.neurons[pathway.source];
        if (sourceNeuron) {
          for (const synapse of sourceNeuron.synapses) {
            if (synapse.targetNeuronId === pathway.target) {
              synapse.conductance += 0.5;
            }
          }
        }
        
        // Trigger visualization pulse
        this.spawnPulse(pathway.source, pathway.target, 0.9, "#ffffff");
      }
    }
  }
}
```

**Step 3: Verify replay**
Add a temporary button in `BrainScene.tsx` to trigger replay:
```typescript
// In BrainScene.tsx return JSX
<button
  onClick={() => {
    if (simulationRef.current instanceof SpikingEngine) {
      simulationRef.current.triggerMemoryReplay();
    }
  }}
  style={{ position: 'absolute', bottom: '10px', left: '10px', zIndex: 100 }}
>
  Trigger Replay
</button>
```

Run the app, click the button, and observe replay activity.

**Step 4: Commit**
```bash
git add src/engine/SpikingEngine.ts
# Remove the debug button from BrainScene.tsx if added
git restore src/components/BrainScene.tsx
git commit -m "feat(spiking-engine): implement memory replay and consolidation"
```

---

### Task 7: Implement Interface Methods

**Objective:** Complete all required methods from the `BrainSimulation` interface.

**Files:**
- Modify: `src/engine/SpikingEngine.ts`

**Step 1: Implement remaining methods**
```typescript
// setGraph
setGraph(graph: NeuralGraph): void {
  this.graph = graph;
  this.regionIntensity = new Float32Array(graph.regionOrder.length);
  this.regionFlashIntensity = new Float32Array(graph.regionOrder.length);
  this.pathwayIntensity = new Float32Array(graph.pathways.length);
  this.membranePotentialNorm = new Float32Array(graph.nodes.length);
  this.pulses = [];
  this.initializeNeurons();
}

// setAction
setAction(actionId: BrainActionId): void {
  this.actionId = actionId;
  this.rebuildEligibility();
}

// rebuildEligibility (simplified)
private rebuildEligibility(): void {
  // Reset neuromodulators
  this.neuromodulators.dopamine = 0.3;
  this.neuromodulators.acetylcholine = 0.4;

  // Action-specific neuromodulation
  switch (this.actionId) {
    case "remember-event":
      this.neuromodulators.dopamine = 0.5;
      this.neuromodulators.acetylcholine = 0.8;
      break;
    case "fear-response":
      this.neuromodulators.norepinephrine = 0.9;
      break;
    case "sleep-ripple":
      this.neuromodulators.acetylcholine = 0.2;
      this.triggerMemoryReplay(3.0);
      break;
    default:
      // Default levels
  }
}

// setRunning
setRunning(running: boolean): void {
  this.running = running;
}

// setSpeed
setSpeed(speed: number): void {
  this.speed = speed;
}

// setMaxPulses
setMaxPulses(maxPulses: number): void {
  // In SpikingEngine, pulses are transient and not stored
  // This method is here for interface compatibility
}

// setMemoryIntensity
setMemoryIntensity(intensity: number): void {
  this.memoryIntensity = Math.min(1.0, intensity);

  // Boost hippocampus activity
  const hippoLIndex = this.graph.regionOrder.indexOf("hippocampus-l");
  const hippoRIndex = this.graph.regionOrder.indexOf("hippocampus-r");
  if (hippoLIndex >= 0) this.regionIntensity[hippoLIndex] = this.memoryIntensity * 0.8;
  if (hippoRIndex >= 0) this.regionIntensity[hippoRIndex] = this.memoryIntensity * 0.8;
}

// flashRegions
flashRegions(regionIds: BrainRegionId[], magnitude: number = 0.85): void {
  for (const regionId of regionIds) {
    const regionIndex = this.graph.regionOrder.indexOf(regionId);
    if (regionIndex >= 0) {
      this.regionFlashIntensity[regionIndex] = Math.max(
        this.regionFlashIntensity[regionIndex],
        magnitude
      );
    }
  }
}

// flashLogicalRegion
flashLogicalRegion(id: string, magnitude: number = 0.85): void {
  const regions = LOGICAL_REGION_MAP[id as LogicalRegionId];
  if (regions) {
    this.flashRegions(regions, magnitude);
  }
}

// spawnPulse (for visualization)
private spawnPulse(fromNode: number, toNode: number, intensity: number, color?: string): void {
  const pathway = this.graph.pathways.find(
    p => p.source === fromNode && p.target === toNode
  );
  if (!pathway) return;

  this.pulses.push({
    id: Date.now(),
    pathwayIndex: pathway.id,
    fromNode,
    toNode,
    progress: 0,
    velocity: 1.0,
    intensity,
    colorRegionId: pathway.sourceRegionId,
    colorRegionIndex: pathway.sourceRegionIndex,
    reverse: false,
    actionColor: color || "#ffffff",
  });
}
```

**Step 2: Verify interface compatibility**
```bash
npm run typecheck
```
Expected: No errors related to `SpikingEngine`

**Step 3: Commit**
```bash
git add src/engine/SpikingEngine.ts
git commit -m "feat(spiking-engine): implement BrainSimulation interface methods"
```

---

### Task 8: Update `BrainScene.tsx` to Use `SpikingEngine`

**Objective:** Switch the engine toggle to use `SpikingEngine` by default.

**Files:**
- Modify: `src/components/BrainScene.tsx`

**Step 1: Update engine toggle**
```typescript
// Change line 27 from
const USE_SPIKING_ENGINE = false;
// to
const USE_SPIKING_ENGINE = true;
```

**Step 2: Verify switch**
Run the app (`npm run dev`) and check that:
1. The brain renders correctly
2. Spikes appear in console logs
3. Regions light up during activity
4. Oscillation phases progress

**Step 3: Commit**
```bash
git add src/components/BrainScene.tsx
git commit -m "feat(spiking-engine): switch BrainScene to use SpikingEngine by default"
```

---

## Next Steps
1. **Implement Task 9:** Enhance `BrainVisualEffects.ts` for advanced spiking visualizations.
2. **Implement Task 10:** Add comprehensive unit tests.
3. **Optimize:** Profile and optimize performance (Web Workers, WebGL).
4. **Validate:** Run full QA using `risk-based-tester` skill.

Ready to execute using `subagent-driven-development`. Shall I proceed?