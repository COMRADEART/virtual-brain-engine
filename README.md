# Virtual Brain Engine

An interactive React + Vite + TypeScript prototype for a navigable, X-ray-style 3D human brain simulation. It renders a transparent outer brain shell, 1,000+ instanced neuron nodes, buffer-geometry synaptic pathways, clickable brain regions, and animated signal pulses driven by selectable brain actions.

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

- `src/components/BrainScene.tsx` owns the Three.js renderer, camera, OrbitControls, raycasting, and render loop.
- `src/components/BrainShell.tsx` builds the transparent brain shell and X-ray fold traces.
- `src/components/NeuralGraph.tsx` renders neurons with `InstancedMesh`, pathways with `BufferGeometry`, clickable region volumes, and pulse instances.
- `src/components/RegionControls.tsx` and `src/components/InfoPanel.tsx` provide the scientific control surface and readouts.
- `src/engine/neuralGraphGenerator.ts` creates deterministic region-aware neural graphs.
- `src/engine/signalSimulation.ts` keeps mutable simulation state outside React so activity can update every frame without UI re-renders.

## Activity Model

Each action maps to active brain regions. The simulation weights internal and external pathways connected to those regions, spawns electrical pulses, moves them from source nodes to target nodes, and decays region and pathway intensity over time. The renderer reads those mutable intensity buffers each animation frame to brighten regions, color synaptic pathways, and position the moving pulse instances.
