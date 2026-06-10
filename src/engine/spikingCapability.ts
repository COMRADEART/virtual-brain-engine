// Phase 4 — runtime GPU-capability probe deciding whether the biologically
// plausible spiking substrate (AdvancedBrainCore/SpikingEngine + EffectComposer
// + UnrealBloomPass + custom shaders) can actually RENDER on this machine.
//
// Why this gate exists: software WebGL backends render the spiking/hybrid shader
// path BLACK. `scripts/verify-canvas.mjs` runs headless under `--disable-gpu`
// (the default smoke), and `VERIFY_GPU=1` drops that flag for a real GPU. So the
// engine choice MUST be gated on real-GPU capability: spiking is the DEFAULT on
// a hardware GL context, and falls back to the lightweight SignalSimulation on a
// software backend — which keeps the SwiftShader/Basic-Render smoke green while
// `VERIFY_GPU=1 verify:canvas` exercises the spiking path as the default.
//
// MEASURED, not guessed (the Phase 1d "measure don't guess" lesson). On the dev
// box, `scripts/measure-gl-renderer.mjs` reports:
//   --disable-gpu : "ANGLE (Microsoft, Microsoft Basic Render Driver (...) D3D11)"
//   VERIFY_GPU=1  : "ANGLE (Intel, Intel(R) Arc(TM) Graphics (...) D3D11)"
// so the software regex below is anchored on the strings that actually appear,
// plus the well-known cross-platform software backends (SwiftShader on Linux/CI,
// Mesa llvmpipe/softpipe) so the gate holds beyond this one machine.
//
// Conservative bias: ANY uncertainty (no WebGL, no debug-renderer extension,
// empty renderer string, a thrown error) resolves to NOT capable. A wrong
// "capable" verdict is a black canvas (a hard regression); a wrong "incapable"
// verdict is just the working fallback. The downside is asymmetric, so we lean
// to the safe side.

// Software / non-accelerated WebGL backends that render the spiking shaders black.
// `basic render` ← the MEASURED Windows `--disable-gpu` string; the rest are the
// standard software backends on other platforms / CI.
const SOFTWARE_RENDERER_RX =
  /swiftshader|basic render|\bsoftware\b|llvmpipe|softpipe|mesa offscreen|microsoft basic/i;

let cached: boolean | null = null;

/**
 * True when the current context has a real, hardware-accelerated WebGL renderer
 * capable of the spiking visual pipeline. Memoised — the throwaway probe context
 * is created at most once (all WebGL contexts in a process share the backend, so
 * the probe's UNMASKED_RENDERER matches what the live THREE renderer will get).
 */
export function detectSpikingCapability(): boolean {
  if (cached !== null) {
    return cached;
  }
  cached = probe();
  return cached;
}

function probe(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) {
      return false; // no WebGL at all → certainly not spiking-capable
    }
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (!dbg) {
      // Can't read the adapter string (privacy-hardened browser, locked-down
      // context). Assume software to avoid risking a black canvas.
      return false;
    }
    const renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "");
    if (renderer.length === 0) {
      return false;
    }
    return !SOFTWARE_RENDERER_RX.test(renderer);
  } catch {
    return false;
  } finally {
    // Free the throwaway GL context (browsers cap concurrent contexts ~16).
    try {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* best-effort */
    }
  }
}

/** Test seam — drop the memoised verdict so a probe re-runs. */
export function __resetSpikingCapabilityCache(): void {
  cached = null;
}
