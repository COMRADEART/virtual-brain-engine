# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server, bound to `127.0.0.1:5173`. The host binding is intentional (the verify-canvas script targets that exact URL); don't switch it to `0.0.0.0` or a different port without updating `scripts/verify-canvas.mjs`.
- `npm run build` — runs `tsc` (type-check only, `noEmit`) then `vite build`. A type error fails the build.
- `npm run preview` — preview the production build at `127.0.0.1`.
- `npm run verify:canvas` — headless smoke test (see below). **Requires the dev server to already be running**; it does not start one.

There is no test runner, linter, or formatter wired up. `tsc` (via `npm run build`) is the only static check.

### verify:canvas

`scripts/verify-canvas.mjs` is the project's end-to-end check. It launches headless Chrome/Edge via the Chrome DevTools Protocol (no Puppeteer dependency), navigates to `VERIFY_URL` (default `http://127.0.0.1:5173/`), samples a 96×60 region of the `<canvas>`, and asserts that ≥90 pixels have luma >24 — i.e. the Three.js scene is actually drawing, not just mounting. It also captures `Runtime.exceptionThrown` and console errors, writes a screenshot to `artifacts/virtual-brain-engine.png`, and exits non-zero on a blank canvas or any thrown exception. Use this to confirm rendering works after non-trivial changes to `BrainScene`, `NeuralGraph`, `BrainShell`, or the simulation/graph generator. Override the target with `VERIFY_URL=...`.

## Architecture

### Rendering vs. React boundary (the core design choice)

The simulation state — `regionIntensity`, `pathwayIntensity`, and the `pulses` array on `SignalSimulation` — is **deliberately held outside React** as mutable Float32Arrays / a mutable array. React owns *config* (selected action, speed, density, visibility, shell opacity, camera preset); the render loop in `BrainScene` calls `simulation.step(delta, elapsed)` and then `graphRenderer.update(...)` every frame, mutating instance matrices and color buffers directly. **Do not lift per-frame simulation state into React state** — it would trigger re-renders at 60 Hz and defeat the whole architecture. When you need React to react to a config change, route it through one of the `simulation.setX(...)` methods (already wired in `BrainScene` effects).

### Data flow

1. `App.tsx` holds all user-facing config in `useState` and passes it to `BrainScene`, `RegionControls`, and `InfoPanel`.
2. `BrainScene` (`src/components/BrainScene.tsx`) is the single Three.js host. One `useEffect` builds the scene/renderer/camera/controls/shell on mount. A separate effect, keyed on `neuronDensity`, rebuilds the `NeuralGraph` and swaps in a fresh `NeuralGraphRenderer` + `SignalSimulation`. Other props feed `simulation.setAction / setSpeed / setRunning`, `setBrainShellOpacity`, and `graphRenderer.applyRegionVisibility` through small effects — those don't tear down the scene.
3. The render loop reads refs (`visibilityRef`, `selectedRegionRef`) rather than closing over props so the single long-lived `renderFrame` keeps seeing the latest values without re-subscribing.
4. Region clicks come from raycasting against the invisible region volume meshes exposed as `graphRenderer.regionMeshes`; the hit's `userData.regionId` is sent back up via `onRegionSelect`.

### Engine layer (`src/engine/`)

- `types.ts` — all shared types. `BrainRegionId` and `BrainActionId` are string-literal unions; adding a region or action means updating both `types.ts` and `src/data/regionDefinitions.ts`, plus the `REGION_CONNECTIONS` adjacency list in `brainRegions.ts`.
- `brainRegions.ts` — derives `REGION_ORDER`, `REGION_INDEX`, `REGION_BY_ID`, `ACTION_BY_ID` lookup tables from the data file, and defines `REGION_CONNECTIONS` (inter-region edge counts) used by the graph generator.
- `neuralGraphGenerator.ts` — deterministic graph builder seeded by `density` (seed = `round(density*1000)+19` in `BrainScene`). Produces `NeuralGraph` with `nodes`, `pathways`, `regionRanges`, `regionOrder`, and a flat `nodePositions` Float32Array. Uses an O(n) sliding-window heuristic for intra-region locality rather than a true nearest-neighbor pass — keep that property if you change it.
- `signalSimulation.ts` — `SignalSimulation` owns the mutable intensity buffers and pulse list. `step()` decays intensities, spawns weighted pulses biased toward the active action's regions (`rebuildEligiblePathways` precomputes the eligible set on action change), advances each pulse along its pathway, and reflects pulse progress back into region/pathway intensity. `MAX_PULSES = 260` caps the active pool. Random number generation is seeded (mulberry32) so replays are deterministic.

### Renderer details (`src/components/NeuralGraph.tsx`)

`NeuralGraphRenderer` packs all neurons into a single `InstancedMesh`, all pathways into one `LineSegments` with a per-vertex color `BufferGeometry`, and all pulses into a second `InstancedMesh`. Hiding a region is done by writing a zero-scale matrix for its neurons, not by toggling `visible` on individual meshes. Region volumes (the clickable hit-test shells) live in `regionMeshes` and are the only objects the raycaster intersects.

## Conventions

- TypeScript `strict: true` is on. The build will fail on implicit `any` or unchecked nullables.
- React 18 with the automatic JSX runtime (`jsx: "react-jsx"`) — no `import React` needed.
- Three.js is imported as `import * as THREE from "three"`. Examples (`OrbitControls`) come from `three/examples/jsm/...`. Stay on the pinned version (`^0.171.0`) — examples sometimes break across minor releases.
