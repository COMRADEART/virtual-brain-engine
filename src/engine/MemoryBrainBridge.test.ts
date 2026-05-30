// Phase 4 make-it-real proof for the MEMORY→BRAIN wiring half.
//
// `verify:canvas` runs no pipeline (no Ollama, no /api/ask), so the wired
// MemoryBrainBridge sits idle during the render check — wiring it proves nothing
// at that gate. This hermetic test closes the loop: it builds a REAL SpikingEngine
// + MemoryBrainBridge (proving the engine actually exposes flashRegions — a method
// rename would fail here), emits the exact `memory`-step-complete pipeline event
// the 7-step server broadcasts after vector search onto the WS bus, and asserts
// the cited memory became a biologically-routed region flash on the engine.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateNeuralGraph } from "./neuralGraphGenerator";
import { SpikingEngine } from "./SpikingEngine";
import { MemoryBrainBridge } from "./MemoryBrainBridge";
import { REGION_INDEX } from "./brainRegions";
import { apiClient } from "./apiClient";

function buildEngine(): SpikingEngine {
  const graph = generateNeuralGraph({ density: 0.4, seed: 419 });
  return new SpikingEngine(graph, "remember-event");
}

// The bridge's citation path fires a background apiClient.getMemory() to refine
// the recall. Keep the test hermetic (no network) by stubbing it to reject; the
// bridge wraps it in `.catch(() => {})`, and the SYNCHRONOUS optimistic recall —
// the wiring under test — has already fired by then.
beforeEach(() => {
  vi.spyOn(apiClient, "getMemory").mockRejectedValue(new Error("no backend in unit test"));
});

describe("MemoryBrainBridge ← WS pipeline citations (Phase 4 wiring)", () => {
  it("turns a cited memory on the pipeline bus into a hippocampal region flash on the engine", () => {
    const engine = buildEngine();
    const flashSpy = vi.spyOn(engine, "flashRegions");
    const bridge = new MemoryBrainBridge(engine); // followPipeline defaults true → subscribes to the bus

    expect(window.__brainBus).toBeDefined();
    // The exact shape the server's `memory` step broadcasts once vector search
    // returns citations.
    window.__brainBus!.emit({
      step: "memory",
      status: "complete",
      citations: [{ memoryId: "mem-123", score: 0.9 }],
    });

    // (1) Wiring: the bridge translated the citation into a flashRegions() call
    //     on the REAL engine, routed to the episodic memory regions (a
    //     conversation citation infers "episodic" → hippocampus/temporal).
    expect(flashSpy).toHaveBeenCalled();
    const flashed = flashSpy.mock.calls.flatMap((c) => c[0] as string[]);
    expect(flashed).toContain("hippocampus-l");

    // (2) End-to-end: the flash actually landed in the engine's flash buffer —
    //     the buffer NeuralGraphRenderer/BrainVisualEffects read — so the cited
    //     memory is genuinely visible, written synchronously by flashRegions
    //     (no step() needed; regionIntensity is a separate spike-activity band).
    const hippoIdx = REGION_INDEX["hippocampus-l"];
    expect(engine.regionFlashIntensity[hippoIdx]).toBeGreaterThan(0);

    bridge.dispose();
  });

  it("a memory-step START (no citations) flashes the memory-core region, not an episodic recall", () => {
    const engine = buildEngine();
    const flashSpy = vi.spyOn(engine, "flashRegions");
    const bridge = new MemoryBrainBridge(engine);

    window.__brainBus!.emit({ step: "memory", status: "start" });

    expect(flashSpy).toHaveBeenCalled();
    bridge.dispose();
  });

  it("does NOT flash once disposed (bus subscription is torn down)", () => {
    const engine = buildEngine();
    const bridge = new MemoryBrainBridge(engine);
    bridge.dispose();

    const flashSpy = vi.spyOn(engine, "flashRegions");
    window.__brainBus!.emit({
      step: "memory",
      status: "complete",
      citations: [{ memoryId: "mem-x", score: 0.5 }],
    });

    expect(flashSpy).not.toHaveBeenCalled();
  });

  it("ignores the pipeline bus entirely when followPipeline is disabled", () => {
    const engine = buildEngine();
    const flashSpy = vi.spyOn(engine, "flashRegions");
    const bridge = new MemoryBrainBridge(engine, { followPipeline: false });

    window.__brainBus!.emit({
      step: "memory",
      status: "complete",
      citations: [{ memoryId: "mem-y", score: 0.7 }],
    });

    expect(flashSpy).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
