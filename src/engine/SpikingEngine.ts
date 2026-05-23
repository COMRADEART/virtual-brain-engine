// SpikingEngine — compatibility alias for AdvancedBrainCore
// =========================================================
//
// The biologically-plausible engine now lives in `AdvancedBrainCore.ts`, which
// composes the Izhikevich population, the CSR connectome, neuromodulation,
// oscillations, predictive coding, memory, and homeostasis. This file used to
// hold an earlier, incomplete LIF implementation; it is kept only as a stable
// import surface so existing consumers (`BrainScene`, `MemoryBrainBridge`) keep
// working without churn. `SpikingEngine` IS `AdvancedBrainCore` — `instanceof`,
// `new SpikingEngine(...)`, and every method/getter resolve to the real class.

export { AdvancedBrainCore as SpikingEngine } from "./AdvancedBrainCore";
export type { ReplayEvent } from "./AdvancedBrainCore";
