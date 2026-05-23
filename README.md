# Virtual Brain Engine: Advanced Biologically Plausible Brain Simulation

A **major neuroscience upgrade** transforming the previous prototype into a biologically grounded, multi-scale neural simulation with emergent cognitive behavior. Features:
- Izhikevich neuron models supporting bursting, adaptation, and realistic firing patterns
- Realistic connectome (20 regions) with small-world topology, modular structure, and rich-club hubs
- Full neuromodulatory system: Dopamine, Acetylcholine, Serotonin, Norepinephrine
- Multiple brain oscillations (Theta, Alpha, Beta, Gamma) with cross-frequency coupling
- Multi-memory system (working, episodic, semantic, procedural) with STDP and consolidation
- Emergent cognitive states demonstrating neuroscience-grounded phenomena

Renders a transparent brain shell with **1,500–3,000 neurons** (80% excitatory/20% inhibitory) in instanced 3D, realistic synaptic pathways, and dynamic visualizations of neural activity, neuromodulators, oscillations, and memory traces.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Architecture

**Core Neuroscience Modules:**
- `src/engine/IzhikevichNeuron.ts`: Biologically plausible neuron models with bursting/adaptation
- `src/engine/RealisticConnectome.ts`: HCP-inspired network with small-world topology
- `src/engine/NeuromodulationSystem.ts`: DA/ACh/5HT/NE dynamic modulation
- `src/engine/BrainOscillations.ts`: Theta/Alpha/Beta/Gamma with coupling
- `src/engine/MemorySystem.ts`: Multi-memory system with STDP/consolidation

**Orchestration:**
- `src/engine/AdvancedBrainCore.ts`: Unified simulation coordinating all systems

**Visualization:**
- `src/components/BrainScene.tsx`: Render loop with neuromodulator tinting
- `src/components/NeuralGraph.tsx`: Instanced neurons/pathways + oscillations
- `src/components/EmergentBehaviorControls.tsx`: Cognitive phenomena triggers
- `src/engine/BrainVisualEffects.ts`: GPU-accelerated neural activity rendering

**Utilities:**
- `src/engine/PerformanceManager.ts`: Adaptive quality control
- `src/engine/emergentActions.ts`: Neuroscience-grounded behavioral patterns

## Neuroscience Model

**Neural Dynamics:**
- Izhikevich neurons with receptor-specific neuromodulator sensitivity
- 80% excitatory (Regular Spiking/Chattering), 20% inhibitory (Fast Spiking)
- Conductance-based synapses with AMPA/NMDA/GABA_A/GABA_B receptors

**Network Dynamics:**
- Biologically grounded 20-region connectome with hierarchical organization
- Small-world topology (high clustering, short path lengths)
- Rich-club hubs (precuneus, posterior cingulate, medial prefrontal)

**Neuromodulation:**
- Region-specific receptor densities for DA, ACh, 5HT, NE
- Volume transmission with slow kinetics (seconds-minutes)
- Dynamic modulation of plasticity, gain, and neural rhythms

**Memory Systems:**
- Working memory (prefrontal/parietal, capacity-limited)
- Episodic memory (hippocampal-neocortical replay)
- Semantic memory (temporal abstraction)
- Procedural memory (basal ganglia reinforcement)

**Emergent Phenomena:**
- Attentional Blink: Limited neural resources create ~200ms unresponsiveness
- Eureka Moment: Prefrontal gamma bursts via dopaminergic reward
- Memory Consolidation: Hippocampal replay → neocortical storage
- Creative States: Default-mode network activation under high ACh

**Visualization Features:**
Press **E** to toggle emergent behavior controls
- Neuromodulator tinting (DA: orange-red, ACh: blue-white)
- Oscillation "breathing" effects (theta-gamma coupling)
- Memory replay trails (hippocampus → neocortex)
- Spike raster (color-coded by neuron type)
