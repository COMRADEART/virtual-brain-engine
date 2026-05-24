# Virtual Brain Engine — Improvement Plan

Grounded review of the spiking-engine + renderer path. Every item cites a real
file/line. Ordered by impact for a 1–4 week budget.

> **Status legend:** ✅ done · 🔲 todo

---

## Top 3 (everything else depends on these)

1. **Stabilize the seizing network** (see 🔴 Critical finding). The render path is
   fixed and verified; the *dynamics* are in permanent runaway (every neuron every
   step). 2A (Mg²⁺ block) ✅ landed but is insufficient alone. Next: 2B substeps +
   NaN guard, then E:I gain tuning to sparse firing. **Product decision needed:**
   invest the multi-day stabilization, or ship `SignalSimulation` and mark
   `AdvancedBrainCore` experimental.
2. Stop the renderer's redundant per-frame per-neuron CPU work (1B) — prerequisite
   for 20k neurons. (The shader compile error and the render-path hang/h:0 bugs are
   ✅ fixed.)
3. Add a real `BrainSnapshot` save/load spanning every subsystem — STDP mutates
   connectome weights every frame with no way to persist them today.

---

## ✅ RESOLVED (2026-05-23) — AdvancedBrainCore seizure stabilized

The runaway below was fixed this session. Verified via `scripts/diag-probe.mjs`
against a **production build** (deterministic; dev StrictMode double-mount + HMR
made dev observations unreliable). Steady state now: **~3–4 % of neurons fire per
step** (was 100 %), `gNmda` mean ≈ 0.9 (was 360–1161), `gAmpa` ≈ 0.15, `gGabaA`
≈ 3, recovery `u` mean ≈ −8 (was 257), `homeostaticGain` actively adapting
(0.4→0.6), no numerical divergence. The fixes, all landed:
1. **2A** NMDA Mg²⁺ block (`IzhikevichNeuron.ts`).
2. **2B** fixed-substep integration — 8 × 0.5 ms Izhikevich steps/frame with the
   drive re-applied each substep (`AdvancedBrainCore.step()`), izh timestep set to
   0.5 ms, plus a NaN/divergence guard in `izh.update()`.
3. **E:I retune** `AMPA_GAIN 0.9→0.09`, `NMDA_GAIN 0.25→0.018`, `GABA_GAIN
   1.1→2.6` (`AdvancedBrainCore.ts`).
4. **Post-reset fire flash** — `firedFlash` overlay on `membranePotentialNorm` so a
   spike's +30 mV peak renders before the reset (`step()`).

**Remaining known gap — `gr.neuronMesh` membrane heatmap does not render.** The
material swap in `applyVisualEffectsToGraph` (custom `NEURON_FRAG` ShaderMaterial on
the neuron `InstancedMesh`) is decorative-only: the mesh's draw fires once
(`onBeforeRender` counter = 1) then stops, so the per-neuron membrane heatmap never
shows. Forcing the fragment to opaque magenta produced **no** magenta — proof those
pixels aren't from this mesh. The **live spiking visuals come from
`BrainVisualEffects.group`** instead: `RegionBreathing` (26 region-glow meshes),
`PulseTrails`, and `NeurotransmitterParticles`, all driven by the now-healthy
`regionIntensity`/spike stream — so the brain reads as a vivid, *pulsing* cloud
(bright during bursts, dimmer between, which is biologically apt). Repairing the
dedicated neuron heatmap is folded into **1B** (move to a Points cloud + point
sprites, or recompute the instance-aware bound; raw 1–2 px additive spheres of
radius 0.01 won't read well anyway). Tracked as its own task.

---

## 🟡 Original finding (2026-05-23) — AdvancedBrainCore ran in permanent seizure

While verifying the `?useSpiking=true` render path, instrumented the live engine
via `scripts/diag-probe.mjs` (CDP read of the running sim's internals). The render
path is now healthy, **but the dynamics are not**: the network is in full
epileptic runaway.

**Evidence (balanced preset, N=1417, ~10 s after load):**
- `lastStepSpikes: 1417` / `lsUnique: 1417` — **every neuron fires every 1 ms step**
  (indices `[0,1,2,…]`, i.e. all of them). Physically impossible from external
  drive alone (c→+30 in one step needs `dv≈+95`); it is sustained by synaptic
  positive feedback.
- `gNmda` mean **360**, max 858 — astronomical. NMDA had **no Mg²⁺ block**, so it
  acted as a second slow AMPA and dominated: `I_syn ≈ g_nmda·(0−v) ≈ 360·65 ≈ 23k`.
- `gAmpa` mean ~58 (should be ~0.5–2). `gGabaA` mean ~11 → **E:I ≈ 33:1**.
- `u` (recovery) saturated at mean ~257 (normal −15..30) — fighting the runaway
  and losing.
- `memMin/Max` pinned at **0.136 / 0.273** (v = −65 / −50 mV) regardless of drive,
  because `writeMembranePotentialsNormalized` samples **after** every neuron has
  spiked and reset → the +30 mV peak is never captured → the brain renders dim/dead
  even though it is hyperactive.

**This is why the engine was "never visually verified" — it was committed in a
non-functional state (commit 117c2fb).** The render pipeline (shader, attributes,
material swap, sim→GPU data flow) is all correct and confirmed working by the probe.

**Decisive experiments run this session (all reverted except the Mg block):**
- Mg²⁺ block alone (2A): gNmda 360→246, but **runaway persists** — AMPA (mean 50)
  alone still drives all-fire.
- Mg block + AMPA/NMDA gains cut ~6× + GABA ×2.3: runaway **breaks** (firing 1417→
  1147, membrane finally varies `memMax 0.993`, `vMax 29.2` — neurons mid-spike →
  visuals would come alive) **but** Euler at `dt=1 ms` then **diverges**
  (`vMin −4423`). → needs the 2B substep refactor + a NaN/divergence guard to be
  numerically stable, then real E:I tuning (1147/1417 is still far from a ~1–10%
  sparse target).

**Conclusion:** stabilization is *tractable but multi-day* (genuine research
tuning, not a one-knob fix). Path = 2A (Mg block, ✅ landed) → 2B (substeps + NaN
guard) → E:I gain tuning to sparse firing → fix the post-reset visual sampling.
Alternative: keep `SignalSimulation` as the shipping path and mark
`AdvancedBrainCore` experimental. **Needs a product decision before the multi-day
invest.**

---

## ✅ Render-path fixes landed this session (2026-05-23)

Both verified via `scripts/cdp-shot.mjs` (canvas `h:719`, main thread responsive
<60 ms, zero GL errors/exceptions on both `/` and `/?useSpiking=true`).

- **dispose() infinite-loop hang** (`BrainVisualEffects.ts` ~1002). The composer
  teardown used `while (passes.length > 0)` but *skipped* removing the kept passes
  (`neuromodPass`/`filmGrainPass`) — so when one was at index 0 the array never
  shrank → infinite loop, hanging the main thread on StrictMode's double-mount
  dispose. This was the real reason the spiking path appeared "broken." Fixed with
  a snapshot iteration (`for (const pass of [...passes])`).
- **Canvas collapsed to `h:0`** in the spiking path only. `BrainScene` forced
  `containerRef.style.position = "relative"`, overriding the `.brain-scene`
  `position: absolute; inset: 0` rule — under `relative`, `inset` only offsets and
  no longer stretches the box, so the container (and the canvas's `height:100%`)
  collapsed to 0 → framebuffer-incomplete + `Shader Error 1286`
  (`GL_INVALID_FRAMEBUFFER_OPERATION`, all downstream of zero size). The override
  was also redundant (an `absolute` box is already a containing block). Removed it.

---

## Priority 1 — Performance & Scalability (target 20k neurons)

The simulation core already scales: the CSR connectome (`RealisticConnectome.ts`)
makes propagation `O(spikes × out-degree)` and auto-scales degree past 6k. **The
wall is the renderer's per-frame CPU, not the math.**

### ✅ 1A. Fixed the `NEURON_FRAG` compile error
`src/engine/BrainVisualEffects.ts` — the fragment shader had **two `void main()`**
definitions plus an orphan `return col;`. That is a hard GLSL link failure, so the
swapped-in `ShaderMaterial` rendered nothing (the reason the spiking path was
"unverified"). Removed the duplicate `main()` + orphan statement.

### ✅ 1C-quick-wins (low-risk, applied)
- **Upload `neuronType` once.** It is fixed at connectome-build time but was
  re-uploaded every frame from `BrainScene.renderFrame`. Added a
  `neuronTypeUploaded` guard in `BrainVisualEffects.updateNeuronAttributes`
  (reset on `attachNeuronGeometry`). `burstStatus`/`memoryTrace`/`membraneNorm`
  still upload per frame — they change.
- **Killed two `O(R²)` per-frame `indexOf` calls** → `REGION_INDEX[regionId]`
  (`NeuralGraph.tsx` `updateRegionVolumes`, `BrainVisualEffects.ts`
  `updateRegionBreathing`). Proven equivalent: `graph.regionOrder`,
  `node.regionIndex`, and global `REGION_INDEX` all derive from
  `REGION_DEFINITIONS` in the same order.

### 🔲 1B. Stop rewriting the full instance buffers every frame *(the 20k unlock)*
`src/components/NeuralGraph.tsx` `update()` runs two `O(N)` allocating passes
every frame, both **wasted in spiking mode** (the ShaderMaterial reads custom
attributes, not `instanceColor`):
- `updateNeuronColors` (~301–318): `new THREE.Color("#000000")` per hidden neuron
  + full `instanceColor` re-upload.
- `updateNeuronMatricesLOD` (~325–340): `new THREE.Vector3(...)` **per neuron per
  frame** + full `instanceMatrix` re-upload — though **positions never change**.

Plan:
- Add `setShaderDriven(on)` / `colorMode: "legacy" | "shader"` to
  `NeuralGraphRenderer`; short-circuit `updateNeuronColors` +
  `updateNeuronMatricesLOD` when shader-driven.
- Positions are static → write `instanceMatrix` once at build, never per frame.
  Move LOD/visibility scaling into `NEURON_VERT` (per-instance `aScale` attribute
  touched only on visibility toggle, or camera-distance LOD in the vertex shader).
- `updateMembranePotential` should use `arr.set(membraneNorm)` not a manual loop.

Expected payoff: removing two allocating `O(N)` passes + two buffer re-uploads per
frame is the difference between stalling ~4k and sustaining 20k.

---

## Priority 2 — Biological & Cognitive Accuracy

### ✅ 2A. NMDA Mg²⁺ voltage gate — landed (Jahr–Stevens 1990)
`src/engine/IzhikevichNeuron.ts` (~475) now gates NMDA with
`mgBlock = 1 / (1 + exp(-0.062·v) · 0.2805)` (≈0.06 at rest, ≈0.8 at 0 mV) so it
only conducts when depolarized — the coincidence detector behind LTP. **Necessary
but not sufficient** to stop the runaway (see Critical finding): it cut gNmda
360→246 but AMPA alone still sustains all-fire. The remaining stabilization
(2B + E:I tuning) is required on top.

### ✅ 2B. Fixed substep integration — landed
`AdvancedBrainCore.step()` now runs **8 × 0.5 ms** Izhikevich substeps per frame
(`FIXED_SUBSTEPS`/`SUB_DT_MS`) with the per-region drive re-applied each substep,
spike propagation + STDP per substep (`SUB_DT_S`), and visual buffers written once
per frame. izh timestep set to 0.5 ms (Euler-stable) + a NaN/divergence guard. This
both un-stuck the network (sustained drive reaches threshold) and was required for
the E:I retune to stay numerically stable. *Original note below for context.*

`AdvancedBrainCore.step()` previously passed real `dt` to oscillations/neuromod but
`izh.update()` advanced a fixed internal 1 ms step **once per frame**
(`IzhikevichNeuron.ts:163, 489`). At 60 fps neurons saw ~6% of real neural time
and were ~16× out of sync with theta. Replaced with an accumulator running
`FIXED_DT = 0.001` sub-steps (cap ~6/frame) where **all** subsystems share the
same dt. Keep visual-buffer writes at frame rate. This is the change that makes
the brain look alive. **Also required for numerical stability:** under corrected
E:I, Euler at `dt=1 ms` diverges (`v→−4423` observed) — add a NaN/divergence guard
in `izh.update()` (`if (!Number.isFinite(v[i])) { v[i]=c[i]; u[i]=b[i]*c[i]; }`)
and re-apply the per-region drive **each substep** (`update()` zeros `I`). Watch:
STDP/`updateRegionActivity` now run K×/frame — pass `sub_dt`, not real `dt`, or
weights/decay mis-tune; `prevSpikes` becomes per-substep not per-frame; K× spikes
may overflow `MAX_PULSES`.

### 🔲 2C. Smaller wins
- Synaptic transmission delay (1–3 ms ring buffer, longer for long-range edges).
- Per-region E/I ratio table (`RealisticConnectome.ts:129` is a flat 80/20;
  cerebellum/striatum/thalamus deviate sharply).

---

## Priority 3 — Save / Load (asked for; currently impossible)

Only `IzhikevichNeuron.serialize()` exists. STDP-learned `RealisticConnectome.weight`,
neuromod levels, oscillation phases, memory traces are unrecoverable.

```ts
// shared/brainSnapshot.ts (zero runtime deps)
export interface BrainSnapshot {
  version: 1;
  density: number; graphSeed: number;          // regenerate identical topology
  neurons: ReturnType<IzhikevichNeuronEngine["serialize"]>;
  connectomeWeights: Float32Array;             // the learned part — the whole point
  neuromod: { dopamine: number; acetylcholine: number; serotonin: number; norepinephrine: number };
  oscillations: { thetaPhase: number; gammaPhase: number };
  action: BrainActionId; savedAt: string;
}
```
- `AdvancedBrainCore.serialize()/load()` fanning out to subsystems;
  `RealisticConnectome` persists only the `weight` array (topology regenerated
  from the seed).
- Persist to **IndexedDB** (Float32Arrays are MBs; localStorage is string-only).
- Gate restore on `version` + `density`/`graphSeed` match.
- Bonus: powers "share a trained brain" + the Snapshot/Replay timeline feature.

---

## Priority 4 — UX & Visualization Polish

**Clutter is in the `full` layout** (`App.tsx:273–354`): ~10 simultaneous surfaces
(`RegionControls`, `InfoPanel`, `DigitalTwinPanel`, `UnifiedPanel` [9-tab, defaults
open], `VisionCortexPanel`, `PipelineOverlay`, `LogicalRegionIndicator`,
`EmergentBehaviorControls`, `StatusBar`). The cure is half-built: 3 layout modes
(`useLayoutMode`), a `CommandPalette`, and `UnifiedPanel` tab consolidation.
- Default to `compact`, not `full`.
- Default `UnifiedPanel` collapsed (`App.tsx:47`); fold `RegionControls` /
  `DigitalTwinPanel` / `VisionCortexPanel` into it or behind the palette so only
  **one** dock floats at a time.

**Wow (mostly free once 1A lands — data already exists):**
- Membrane-potential color legend (shader maps V→color, nothing explains it).
- Live spike raster + EEG band labels (θ/α/β/γ; `updateEegWaveform` exists) +
  DA/ACh/5HT/NE readout bars.
- Click region → camera fly-in + per-region firing-rate sparkline.

---

## Priority 5 — Architecture & Code Quality

- Make the spiking engine default once 1A–1C land; keep `SignalSimulation` as the
  auto-tier low-end fallback (wire to `performancePresets`/`useAutoQuality`)
  instead of a `?useSpiking=true` URL flag.
- `highlightRichClubHubs` runs every frame (`BrainScene.tsx:635`) allocating a
  `THREE.Color` per hub and fighting `updateRegionBreathing` over `uRegionColor`.
  Set once / on change.
- Stretch: move Izhikevich integration + propagation to a Web Worker over
  `SharedArrayBuffer` (data is already flat typed arrays) → path to 50k+.
- New feature: **Snapshot/Replay timeline** built on Priority 3's `serialize()`.

---

## Suggested sequencing

| Week | Focus |
|------|-------|
| 1 | 1B (renderer CPU) → verify 20k; flip spiking to default behind auto-tier |
| 2 | 2B (fixed-step) + 2A (NMDA Mg²⁺) |
| 3 | Priority 3 (`BrainSnapshot` + IndexedDB) |
| 4 | Priority 4 (default compact, fold panels, legends/raster/EEG labels) |

Dependency chain: **1A unblocks all spiking visuals · 1B unblocks 20k · Priority 3
unblocks Snapshot/Replay.**
