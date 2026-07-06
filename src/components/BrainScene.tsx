import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { createBrainShell, setBrainShellOpacity } from "./BrainShell";
import { NeuralGraphRenderer } from "./NeuralGraph";
import { NeuronField } from "./NeuronField";
import { SpineColumn } from "./SpineColumn";
import { createAmbientBus, type AmbientBus } from "../engine/audioBus";
import { generateNeuralGraph } from "../engine/neuralGraphGenerator";
import { SignalSimulation } from "../engine/signalSimulation";
import { SpikingEngine } from "../engine/SpikingEngine";
import { HybridCognitiveCore } from "../engine/cognition/HybridCognitiveCore";
import { isSpikingCapable } from "../engine/types";
import { detectSpikingCapability } from "../engine/spikingCapability";
import { MemoryBrainBridge } from "../engine/MemoryBrainBridge";
import {
  BrainVisualEffects,
  applyVisualEffectsToGraph,
} from "../engine/BrainVisualEffects";

// ─── Engine selection (Phase 4: spiking substrate is now the DEFAULT) ──────
// `SpikingEngine` is an alias for AdvancedBrainCore (Izhikevich neurons over a
// small-world/rich-club connectome with neuromodulation, oscillations,
// predictive coding, memory, and homeostasis). It is the default brain on
// GPU-capable hardware; the lightweight scripted SignalSimulation is the
// no-GPU fallback.
//
// "Behind useAutoQuality/adaptiveQuality" (the roadmap wording) is interpreted
// as: GPU *capability* gates the engine CHOICE (software WebGL renders the
// spiking shaders black — see spikingCapability.ts), while auto-quality scales
// the spiking engine's COST through the existing PerfPreset path (density / DPR
// / bloom / maxPulses). We do NOT swap engines on an FPS dip — that would force
// a full graph+renderer rebuild mid-session; cost-scaling via PerfPreset is the
// established, cheaper lever and the spiking engine already honours it.
//
// URL overrides (no rebuild): `?useSpiking=false` forces the fallback (the
// escape hatch the headless SwiftShader/Basic-Render smoke and flaky GPUs use),
// `?useSpiking=true` forces spiking, `?useHybrid=true` selects the hybrid
// cognitive engine (which implies the spiking substrate).
function resolveEngineChoice(): { spiking: boolean; hybrid: boolean } {
  const search = typeof window !== "undefined" ? window.location.search : "";
  if (search.includes("useSpiking=false")) {
    return { spiking: false, hybrid: false }; // hard escape hatch — fallback engine
  }
  // VITE_FEATURE_HYBRID is a BUILD flag (Vite inlines import.meta.env at build
  // time). Default OFF: the experimental hybrid-cognition engine is unreachable
  // from the default build (?useHybrid=true is a no-op). Build with
  // VITE_FEATURE_HYBRID=true to re-enable it. Runtime gate on a build flag, not a
  // bundle exclusion — the static import + SimulationLike union stay intact.
  const hybrid = import.meta.env.VITE_FEATURE_HYBRID === "true" && search.includes("useHybrid=true");
  const spiking = hybrid || search.includes("useSpiking=true") || detectSpikingCapability();
  return { spiking, hybrid };
}
type SimulationLike = SignalSimulation | SpikingEngine | HybridCognitiveCore;
import { subscribeBrainBus } from "../engine/brainBus";
import { useUiPrefs } from "../engine/uiPrefs";
import type { PerfPreset } from "../engine/performancePresets";
import { PerformanceManager } from "../engine/PerformanceManager";
import { LOGICAL_REGION_IDS } from "../../shared/pipeline";
import type {
  BrainActionId,
  BrainMetrics,
  BrainRegionId,
  CameraPresetRequest,
  RegionVisibility,
} from "../engine/types";
import { EmergentBehaviorControls } from "./EmergentBehaviorControls";

export interface AnatomyLoadProgress {
  loaded: number;
  total: number;
  done: boolean;
}

export interface CameraBookmarkState {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * Imperative scene surface for camera bookmarks + screenshots. The mount
 * effect binds it; consumers hold the ref and call through it — these are
 * one-shot commands, not per-frame state, so they stay outside React state.
 */
export interface BrainSceneApi {
  getCameraState: () => CameraBookmarkState | null;
  flyTo: (state: CameraBookmarkState) => void;
  /** Renders one frame and returns a PNG data URL (null if the scene is gone). */
  screenshot: () => string | null;
}

interface BrainSceneProps {
  simulationRunning: boolean;
  selectedActionId: BrainActionId;
  signalSpeed: number;
  neuronDensity: number;
  shellOpacity: number;
  anatomyVisible: boolean;
  anatomyOpacity: number;
  regionVisibility: RegionVisibility;
  selectedRegionId: BrainRegionId | null;
  cameraPreset: CameraPresetRequest;
  audioEnabled: boolean;
  perfPreset: PerfPreset;
  showEmergentControls?: boolean;
  /** Bound by the mount effect; cleared on unmount. */
  sceneApiRef?: React.MutableRefObject<BrainSceneApi | null>;
  onRegionSelect: (regionId: BrainRegionId) => void;
  onActionSelect?: (actionId: BrainActionId) => void;
  onMetricsChange: (metrics: BrainMetrics) => void;
  onAnatomyLoadProgress?: (progress: AnatomyLoadProgress) => void;
}

interface CameraTransition {
  startTime: number;
  duration: number;
  startPosition: THREE.Vector3;
  endPosition: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
}

// Per-step flash magnitude so the brain visibly distinguishes the 7 pipeline
// steps: memory retrieval / response burn brightest, bookkeeping steps dimmer.
const PIPELINE_STEP_GAIN: Record<string, number> = {
  input: 0.45,
  memory: 0.95,
  reasoning: 0.85,
  project: 0.6,
  error: 0.7,
  response: 0.9,
  learning: 0.55,
};

// Shared soft-circular sprite used by the anatomy point cloud. Built once and
// reused across remounts (HMR-friendly).
let pointSpriteTexture: THREE.Texture | null = null;
function getPointSpriteTexture(): THREE.Texture {
  if (pointSpriteTexture) {
    return pointSpriteTexture;
  }
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return new THREE.Texture();
  }
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.65)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  pointSpriteTexture = texture;
  return texture;
}

// Walk a loaded GLB and pull every position (and color, when available) into
// flat Float32Arrays in world space. Handles both Mesh and Points children so
// we don't care what the GLB was authored as.
function mergePointData(root: THREE.Object3D): {
  positions: Float32Array;
  colors: Float32Array | null;
} {
  root.updateMatrixWorld(true);
  const sources: Array<{
    posAttr: THREE.BufferAttribute;
    colorAttr: THREE.BufferAttribute | null;
    matrix: THREE.Matrix4;
  }> = [];
  let anyColor = false;

  root.traverse((child) => {
    const obj = child as THREE.Object3D & { isMesh?: boolean; isPoints?: boolean; geometry?: THREE.BufferGeometry };
    if ((obj.isMesh || obj.isPoints) && obj.geometry?.attributes.position) {
      const colorAttr = (obj.geometry.attributes.color as THREE.BufferAttribute | undefined) ?? null;
      if (colorAttr) {
        anyColor = true;
      }
      sources.push({
        posAttr: obj.geometry.attributes.position as THREE.BufferAttribute,
        colorAttr,
        matrix: obj.matrixWorld,
      });
    }
  });

  const total = sources.reduce((sum, source) => sum + source.posAttr.count, 0);
  const positions = new Float32Array(total * 3);
  const colors = anyColor ? new Float32Array(total * 3) : null;
  const tmp = new THREE.Vector3();
  let cursor = 0;

  for (const { posAttr, colorAttr, matrix } of sources) {
    for (let i = 0; i < posAttr.count; i += 1) {
      tmp.fromBufferAttribute(posAttr, i);
      tmp.applyMatrix4(matrix);
      positions[cursor * 3] = tmp.x;
      positions[cursor * 3 + 1] = tmp.y;
      positions[cursor * 3 + 2] = tmp.z;
      if (colors) {
        if (colorAttr) {
          colors[cursor * 3] = colorAttr.getX(i);
          colors[cursor * 3 + 1] = colorAttr.getY(i);
          colors[cursor * 3 + 2] = colorAttr.getZ(i);
        } else {
          colors[cursor * 3] = 1;
          colors[cursor * 3 + 1] = 1;
          colors[cursor * 3 + 2] = 1;
        }
      }
      cursor += 1;
    }
  }

  return { positions, colors };
}

export function BrainScene({
  simulationRunning,
  selectedActionId,
  signalSpeed,
  neuronDensity,
  shellOpacity,
  anatomyVisible,
  anatomyOpacity,
  regionVisibility,
  selectedRegionId,
  cameraPreset,
  audioEnabled,
  perfPreset,
  showEmergentControls,
  sceneApiRef,
  onRegionSelect,
  onActionSelect,
  onMetricsChange,
  onAnatomyLoadProgress,
}: BrainSceneProps): JSX.Element {
  // Settings-panel glow intensity. Config-level subscription (same tier as the
  // perf preset), NOT per-frame state — the effect below pokes the bloom pass.
  const { prefs: uiPrefs } = useUiPrefs();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const shellRef = useRef<THREE.Group | null>(null);
  const graphRendererRef = useRef<NeuralGraphRenderer | null>(null);
  // The million-neuron GPU point cloud + the interactive graph's metrics, so the
  // status readout can report the true neuron total (graph + field).
  const neuronFieldRef = useRef<NeuronField | null>(null);
  // The spinal cord — a descending nerve bundle below the brain that animates the
  // server's spine subsystem (efferent commands down, afferent feedback up).
  const spineColumnRef = useRef<SpineColumn | null>(null);
  const graphMetricsRef = useRef<BrainMetrics>({ neurons: 0, pathways: 0, regions: 0 });
  const visualEffectsRef = useRef<BrainVisualEffects | null>(null);
  const simulationRef = useRef<SimulationLike | null>(null);
  const performanceManagerRef = useRef<PerformanceManager | null>(null);
  const transitionRef = useRef<CameraTransition | null>(null);
  const pointCloudRef = useRef<THREE.Group | null>(null);
  const pointCloudMaterialRef = useRef<THREE.PointsMaterial | null>(null);
  const ambientBusRef = useRef<AmbientBus | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const selectedRegionRef = useRef(selectedRegionId);
  const visibilityRef = useRef(regionVisibility);
  // Stash initial values for one-shot use inside the mount-once effect. Subsequent
  // changes flow through the small reactive effects below so we don't rebuild the
  // renderer on every slider tick.
  const initialShellOpacityRef = useRef(shellOpacity);
  const initialAnatomyVisibleRef = useRef(anatomyVisible);
  const initialAnatomyOpacityRef = useRef(anatomyOpacity);
  const initialAudioEnabledRef = useRef(audioEnabled);
  const initialPerfPresetRef = useRef(perfPreset);
  const perfPresetRef = useRef(perfPreset);
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  // Phase 4 — the memory→brain bridge, live only when the plain spiking engine
  // is the active simulation (tails the WS pipeline bus → region flashes).
  const memoryBridgeRef = useRef<MemoryBrainBridge | null>(null);
  // The load-progress callback is read via a ref so the main scene effect
  // doesn't tear down when the parent's callback identity changes.
  const onAnatomyLoadProgressRef = useRef(onAnatomyLoadProgress);
  useEffect(() => {
    onAnatomyLoadProgressRef.current = onAnatomyLoadProgress;
  }, [onAnatomyLoadProgress]);

  useEffect(() => {
    selectedRegionRef.current = selectedRegionId;
  }, [selectedRegionId]);

  useEffect(() => {
    visibilityRef.current = regionVisibility;
    graphRendererRef.current?.applyRegionVisibility(regionVisibility);
  }, [regionVisibility]);

  useEffect(() => {
    simulationRef.current?.setRunning(simulationRunning);
  }, [simulationRunning]);

  useEffect(() => {
    simulationRef.current?.setAction(selectedActionId);
  }, [selectedActionId]);

  useEffect(() => {
    simulationRef.current?.setSpeed(signalSpeed);
  }, [signalSpeed]);

  // Server pipeline events flash logical cortices on the brain. Status === "start"
  // is the leading edge so flashes happen at the same moment the UI shows a step
  // beginning, not when it finishes.
  //
  // We also track the most recent pipeline activity timestamp so the idle
  // "breathing" loop below pauses while a real run is happening.
  const lastPipelineActivityRef = useRef(0);
  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "pipeline") {
        return;
      }
      lastPipelineActivityRef.current = Date.now();
      if (message.status !== "start") {
        return;
      }
      const gain = PIPELINE_STEP_GAIN[message.step] ?? 0.7;
      message.logicalRegions.forEach((region, index) => {
        // Stagger flashes so a multi-region step reads as a travelling wave
        // through the thought, not a single simultaneous blink.
        window.setTimeout(() => {
          simulationRef.current?.flashLogicalRegion(region, gain);
        }, index * 70);
      });
    });
  }, []);

  // Unified cognition stream: every "mental act" (belief formed, goal grown,
  // curiosity spike, reflection, dream, thought, procedure learned, stage
  // advance) flashes its mapped cortices. Magnitude keeps these subordinate
  // to pipeline flashes (0.3-0.9 vs the pipeline's step gains), and the idle
  // breathing loop is untouched — cognition flashes ARE the organism's life
  // between prompts.
  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "cognition") {
        return;
      }
      const gain = 0.3 + 0.6 * Math.max(0, Math.min(1, message.event.magnitude));
      message.event.logicalRegions.forEach((region, index) => {
        window.setTimeout(() => {
          simulationRef.current?.flashLogicalRegion(region, gain);
        }, index * 70);
      });
    });
  }, []);

  // The spinal cord: every motor command travelling the cord spawns a glowing
  // impulse on the 3D column — EFFERENT (down) on dispatch/reflex/program,
  // AFFERENT (up) on feedback — and co-flashes the mapped cortices so cognition
  // and the body read as one connected nervous system.
  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "spine") {
        return;
      }
      const ev = message.event;
      const spine = spineColumnRef.current;
      if (spine) {
        if (ev.kind === "feedback") {
          // Afferent: the outcome climbs back up — green ok / red blocked.
          spine.spawnImpulse(-1, ev.ok === false ? "#ff6f7a" : "#7CFFB2", 1.05, 3.6);
        } else if (ev.kind !== "command-queued") {
          // Efferent: a command descends, tinted by the tract it took.
          const byTract =
            ev.tract === "reflex"
              ? { color: "#ffb347", speed: 1.7, size: 3.0 }
              : ev.tract === "program"
                ? { color: "#7CFFB2", speed: 1.15, size: 3.4 }
                : { color: "#6fe8ff", speed: 0.85, size: 3.8 };
          spine.spawnImpulse(1, byTract.color, byTract.speed, byTract.size);
        }
      }
      // Co-flash the cortices this tract engages (subordinate to pipeline flashes).
      const gain = ev.kind === "feedback" ? 0.4 : 0.55;
      ev.logicalRegions.forEach((region, index) => {
        window.setTimeout(() => {
          simulationRef.current?.flashLogicalRegion(region, gain);
        }, index * 70);
      });
    });
  }, []);

  // Model Hub: a downloading model streams into the brain — flash the model-hub
  // cortex as progress arrives (brighter on completion). Reuses the same
  // flashLogicalRegion path the idle breathing loop already exercises.
  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "model-pull") {
        return;
      }
      simulationRef.current?.flashLogicalRegion("model-hub", message.done ? 1.0 : 0.55);
    });
  }, []);

// Memory count updates drive the hippocampus glow intensity.
  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "memory-count") {
        return;
      }
      const simulation = simulationRef.current;
      simulation?.setMemoryIntensity(message.count);

      // If using SpikingEngine, also trigger memory replay when there's significant memory activity
      if (simulation instanceof SpikingEngine && message.count > 5) {
        simulation.triggerMemoryReplay();
      }
    });
  }, []);

  // Replay events (hippocampal-neocortical consolidation, from the server)
  useEffect(() => {
    return subscribeBrainBus((message) => {
      const simulation = simulationRef.current;
      if (message.type === "replay" && simulation instanceof SpikingEngine) {
        // Forward replay events to the spiking engine to drive theta-burst /
        // gamma-burst stimulation. Spikes are buffered inside the engine and
        // pulled via drainSpikes(), so there is no separate spike WS path.
        simulation.handleReplayEvent(message);
      }
    });
  }, []);

  // Idle breathing: when nothing else is happening, drift slow low-magnitude
  // flashes across the 8 logical cortices. Magnitude is well under the active
  // flash level (~0.85) so a real pipeline event still visibly outshines this.
  useEffect(() => {
    let cursor = 0;
    const id = window.setInterval(() => {
      const sim = simulationRef.current;
      if (!sim) {
        return;
      }
      // Skip if a pipeline step happened in the last 4s — the user is in the
      // middle of an interaction and we shouldn't add noise.
      if (Date.now() - lastPipelineActivityRef.current < 4000) {
        return;
      }
      const region = LOGICAL_REGION_IDS[cursor % LOGICAL_REGION_IDS.length];
      cursor += 1;
      sim.flashLogicalRegion(region, 0.18);
    }, 1800);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    ambientBusRef.current?.setEnabled(audioEnabled);
  }, [audioEnabled]);

  // Performance preset changes apply live without tearing down the scene:
  // re-cap the pixel ratio, toggle the bloom pass, and resize the pulse pool.
  useEffect(() => {
    perfPresetRef.current = perfPreset;
    const renderer = rendererRef.current;
    const composer = composerRef.current;
    const container = containerRef.current;
    if (renderer && container) {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, perfPreset.dprCap));
      renderer.setSize(width, height);
      composer?.setSize(width, height);
      neuronFieldRef.current?.setPixelRatio(Math.min(window.devicePixelRatio, perfPreset.dprCap));
      spineColumnRef.current?.setPixelRatio(Math.min(window.devicePixelRatio, perfPreset.dprCap));
    }
    if (bloomPassRef.current) {
      bloomPassRef.current.enabled = perfPreset.bloom;
    }
    simulationRef.current?.setMaxPulses(perfPreset.maxPulses);
  }, [perfPreset]);

  useEffect(() => {
    if (shellRef.current) {
      setBrainShellOpacity(shellRef.current, shellOpacity);
    }
  }, [shellOpacity]);

  useEffect(() => {
    if (pointCloudRef.current) {
      pointCloudRef.current.visible = anatomyVisible;
    }
  }, [anatomyVisible]);

  useEffect(() => {
    const material = pointCloudMaterialRef.current;
    if (material) {
      material.opacity = anatomyOpacity;
      material.needsUpdate = true;
    }
  }, [anatomyOpacity]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2("#03080d", 0.08);
    sceneRef.current = scene;

    // Atmospheric backdrop (a dim nebula) so the brain reads as floating in
    // deep space rather than over flat color. backgroundIntensity keeps it
    // subtle — it never competes with the additive neurons or trips the bloom
    // threshold — and fog leaves the background untouched, so this is pure
    // depth. Failure-isolated: a missing asset just keeps the prior
    // transparent background, so verify:canvas / the Tauri build still render.
    let backdropTexture: THREE.Texture | null = null;
    let backdropCancelled = false;
    new THREE.TextureLoader().load(
      "/space-backdrop.webp",
      (tex) => {
        if (backdropCancelled) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        backdropTexture = tex;
        scene.background = tex;
        scene.backgroundIntensity = 0.4;
      },
      undefined,
      () => {
        // Asset absent — leave the transparent background in place.
      },
    );

    const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.01, 90);
    camera.position.set(0.1, 0.12, 4.25);
    cameraRef.current = camera;

    // Initialize performance manager and set camera
    const performanceManager = new PerformanceManager();
    performanceManager.setCamera(camera);
    performanceManagerRef.current = performanceManager;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, initialPerfPresetRef.current.dprCap));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    // Accessibility: describe the canvas for screen readers
    renderer.domElement.setAttribute("aria-label", "Interactive 3D brain visualization showing neural activity, regions, and signal propagation");
    renderer.domElement.setAttribute("tabindex", "0");
    renderer.domElement.setAttribute("role", "img");

    // Cinematic glow on bright pixels (pulses + lit regions). The threshold
    // keeps the dark background sharp; only pixels well above neutral bloom.
    const composer = new EffectComposer(renderer);
    composerRef.current = composer;
    composer.setSize(container.clientWidth, container.clientHeight);
    composer.addPass(new RenderPass(scene, camera));
    // Tuned conservatively so the bloom enhances pulses and lit regions without
    // swallowing the neuron / pathway structure underneath. Raise strength /
    // lower threshold if more cinematic glow is wanted.
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.45, // strength
      0.35, // radius
      0.55, // threshold — only pixels already pretty bright will bloom
    );
    // EffectComposer skips disabled passes, so the Light/Balanced presets pay
    // nothing for bloom. The reactive preset effect below flips this live.
    bloomPass.enabled = initialPerfPresetRef.current.bloom;
    bloomPassRef.current = bloomPass;
    composer.addPass(bloomPass);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.enablePan = true;
    controls.minDistance = 0.04;
    controls.maxDistance = 8;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // Imperative scene surface (camera bookmarks + screenshot). Bound here so
    // it closes over the live camera/controls/composer; cleared on teardown.
    if (sceneApiRef) {
      sceneApiRef.current = {
        getCameraState: () => ({
          position: camera.position.toArray() as [number, number, number],
          target: controls.target.toArray() as [number, number, number],
        }),
        flyTo: (state) => {
          transitionRef.current = {
            startTime: performance.now() / 1000,
            duration: 0.8,
            startPosition: camera.position.clone(),
            endPosition: new THREE.Vector3(...state.position),
            startTarget: controls.target.clone(),
            endTarget: new THREE.Vector3(...state.target),
          };
        },
        screenshot: () => {
          // The renderer has no preserveDrawingBuffer, so render a frame and
          // read the canvas back synchronously before the buffer is cleared.
          composer.render();
          try {
            return renderer.domElement.toDataURL("image/png");
          } catch {
            return null;
          }
        },
      };
    }

    scene.add(new THREE.AmbientLight("#7eefff", 0.7));
    const keyLight = new THREE.PointLight("#9dfff2", 2.2, 8);
    keyLight.position.set(1.8, 2.1, 2.4);
    scene.add(keyLight);

    const ambientBus = createAmbientBus();
    ambientBusRef.current = ambientBus;
    if (initialAudioEnabledRef.current) {
      ambientBus.setEnabled(true);
    }

    const shell = createBrainShell({ opacity: initialShellOpacityRef.current });
    shellRef.current = shell;
    scene.add(shell);

    const pointCloudGroup = new THREE.Group();
    pointCloudGroup.name = "BrainPointCloudGroup";
    pointCloudGroup.visible = initialAnatomyVisibleRef.current;
    pointCloudRef.current = pointCloudGroup;
    scene.add(pointCloudGroup);

    // The spinal cord — descends from the brainstem to a body terminus, driven by
    // `spine` bus events (see the subscription effect below). Built once with the
    // scene; an optional higgsfield nerve texture enriches it with a procedural
    // fallback, so the headless render check never blanks.
    const spineColumn = new SpineColumn({
      pixelRatio: Math.min(window.devicePixelRatio, perfPresetRef.current.dprCap),
    });
    spineColumnRef.current = spineColumn;
    scene.add(spineColumn.group);

    let cancelled = false;
    const loader = new GLTFLoader();
    loader.load(
      "/brain_point_cloud.glb",
      (gltf) => {
        if (cancelled) {
          return;
        }

        onAnatomyLoadProgressRef.current?.({ loaded: 1, total: 1, done: true });

        const { positions, colors } = mergePointData(gltf.scene);
        if (positions.length < 3) {
          return;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        if (colors) {
          geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        }
        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox;
        if (bbox) {
          // Auto-fit: center the cloud at the origin, then uniformly scale so its
          // largest extent matches the synthetic shell's overall span. This is
          // baked into the buffer so PointsMaterial.size stays in final world units.
          const center = bbox.getCenter(new THREE.Vector3());
          const size = bbox.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const targetSize = 2.55;
          const fitScale = targetSize / maxDim;
          geometry.translate(-center.x, -center.y, -center.z);
          geometry.scale(fitScale, fitScale, fitScale);
        }
        geometry.computeBoundingSphere();

        const material = new THREE.PointsMaterial({
          map: getPointSpriteTexture(),
          alphaTest: 0.01,
          color: "#9be5ff",
          size: 0.014,
          sizeAttenuation: true,
          transparent: true,
          opacity: initialAnatomyOpacityRef.current,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          vertexColors: colors !== null,
        });
        pointCloudMaterialRef.current = material;

        const points = new THREE.Points(geometry, material);
        points.name = "Anatomical point cloud";
        // Anatomy reference sits behind every other element so neurons and pulses
        // remain crisp over it.
        points.renderOrder = 0;
        // Small downward nudge so the cloud's anatomical "down" aligns with the
        // synthetic shell's brainstem position.
        points.position.y = -0.05;
        pointCloudGroup.add(points);
      },
      (event) => {
        if (cancelled) {
          return;
        }
        // GLTFLoader forwards XHR ProgressEvent. `total` is 0 when the server
        // doesn't send Content-Length; treat that as indeterminate.
        const total = event.total ?? 0;
        const loaded = event.loaded ?? 0;
        onAnatomyLoadProgressRef.current?.({ loaded, total, done: false });
      },
      (error) => {
        console.warn("Could not load brain_point_cloud.glb:", error);
        onAnatomyLoadProgressRef.current?.({ loaded: 0, total: 0, done: true });
      },
    );

    const clock = new THREE.Clock();
    let animationFrame = 0;
    let audioFrameCounter = 0;
    // Frame governor state (see the FPS cap in renderFrame). 0 → first frame
    // always renders.
    let lastFrameMs = 0;

    // Pause simulation when the tab is hidden to save GPU/CPU.
    const handleVisibilityChange = () => {
      simulationRef.current?.setRunning(!document.hidden);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

const renderFrame = () => {
    animationFrame = window.requestAnimationFrame(renderFrame);
    // GPU governor: cap rendered FPS so a continuously-animating scene doesn't
    // peg the GPU at the display's full refresh (60/120/144 Hz). Skipping here
    // skips simulation.step + composer.render together; clock.getDelta() then
    // measures the longer gap, so the simulation still advances in real time and
    // every neuron stays on screen — we just draw fewer frames. 0 = uncapped.
    const fpsCap = perfPresetRef.current.fpsCap;
    if (fpsCap > 0) {
      const nowMs = performance.now();
      if (nowMs - lastFrameMs < 1000 / fpsCap - 1) {
        return;
      }
      lastFrameMs = nowMs;
    }
    const delta = Math.min(clock.getDelta(), 0.05);
    const elapsed = clock.elapsedTime;
    const simulation = simulationRef.current;
    const graphRenderer = graphRendererRef.current;
    const performanceManager = performanceManagerRef.current;
    const visualEffects = visualEffectsRef.current;

    // Update performance manager with frame time in milliseconds
    if (performanceManager) {
      performanceManager.update(delta * 1000);
    }

    updateCameraTransition(elapsed, camera, controls, transitionRef);

    if (simulation && graphRenderer) {
      // Step the simulation
      simulation.step(delta, elapsed);
      // Phase 4 — decay/forget the live memory traces in lock-step with the
      // engine so the bridge's flashes ride the same frame (no-op when null).
      memoryBridgeRef.current?.tick(delta);

      // Update graph renderer
      graphRenderer.update(
        simulation,
        visibilityRef.current,
        selectedRegionRef.current,
        elapsed,
      );

      // Drive the million-neuron field from the SAME region-activity buffers —
      // a tiny per-region uniform copy, independent of the field's point count.
      neuronFieldRef.current?.update(
        simulation.regionIntensity,
        simulation.regionFlashIntensity,
        visibilityRef.current,
        elapsed,
      );

      // Advance the spinal cord (impulse travel + resting tone). Independent of
      // the engine — a tiny per-frame CPU pass over ≤96 impulses.
      spineColumnRef.current?.update(delta, elapsed);

      // Update advanced visual effects if available
      if (visualEffects) {
        // Update with core simulation data
        visualEffects.update(
          elapsed,
          delta,
          visibilityRef.current,
          simulation.regionIntensity,
          simulation.pathwayIntensity,
        );
        
        // Update membrane potential visualization if using SpikingEngine
        if ('membranePotentialNorm' in simulation && simulation.membranePotentialNorm) {
          visualEffects.updateMembranePotential(simulation.membranePotentialNorm);
        }
        
        // Update neuron-specific attributes for any spiking-capable engine.
        // Capability-detected (not `instanceof`) so a composed engine like
        // HybridCognitiveCore — which wraps AdvancedBrainCore by delegation and is
        // therefore NOT an instanceof SpikingEngine — still drives every visual.
        if (isSpikingCapable(simulation)) {
          visualEffects.updateNeuronAttributes(
            simulation.neuronType,
            simulation.getBurstStatus?.(), // If available
            simulation.getMemoryTrace?.() // If available
          );
          
          // Update gamma phase for theta-gamma coupling visualization
          visualEffects.setGammaPhase(simulation.gammaPhase || 0);
          
          // Update neuromodulator levels
          visualEffects.setNeuromodulators({
            dopamine: simulation.dopamine || 0.3,
            acetylcholine: simulation.acetylcholine || 0.4,
            serotonin: simulation.serotonin || 0.2,
            norepinephrine: simulation.norepinephrine || 0.1
          });
          
          // Highlight rich-club hubs (regions with high connectivity)
          const hubRegionIds: BrainRegionId[] = [
            "prefrontal-l", "prefrontal-r", "parietal-l", "parietal-r", 
            "temporal-l", "temporal-r", "thalamus-l", "thalamus-r"
          ];
          visualEffects.highlightRichClubHubs(hubRegionIds, 0.8);
        }
      }

        // Feed average region intensity to the ambient bus every ~6 frames
        // (~10 Hz at 60 fps) so audio tracks activity without polling per tick.
        audioFrameCounter += 1;
        if (audioFrameCounter >= 6) {
          audioFrameCounter = 0;
          const intensities = simulation.regionIntensity;
          let sum = 0;
          for (let index = 0; index < intensities.length; index += 1) {
            sum += intensities[index];
          }
          // Scale up: average intensity rarely exceeds ~0.4, so multiply to
          // map a busy brain into the 0..1 activity range for the bus.
          const level = Math.min(1, (sum / Math.max(1, intensities.length)) * 2.5);
          ambientBusRef.current?.setActivity(level);
        }
      }

      controls.update();
      composer.render();
    };

const resizeObserver = new ResizeObserver(() => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    composer?.setSize(width, height);
    
    // Update visual effects size
    const visualEffects = visualEffectsRef.current;
    if (visualEffects) {
      visualEffects.setSize(width, height);
    }
  });
    resizeObserver.observe(container);

const handlePointerClick = (event: PointerEvent) => {
    const graphRenderer = graphRendererRef.current;
    if (!graphRenderer) {
      return;
    }


    const bounds = renderer.domElement.getBoundingClientRect();
    pointerRef.current.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointerRef.current.y = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
    raycasterRef.current.setFromCamera(pointerRef.current, camera);

    const hits = raycasterRef.current.intersectObjects(graphRenderer.regionMeshes, false);
    const hit = hits.find((entry) => entry.object.visible);
    if (hit?.object.userData.regionId) {
      onRegionSelect(hit.object.userData.regionId as BrainRegionId);
    }
  };

    renderer.domElement.addEventListener("click", handlePointerClick);
    renderFrame();

    return () => {
      cancelled = true;
      backdropCancelled = true;
      scene.background = null;
      if (backdropTexture) {
        backdropTexture.dispose();
        backdropTexture = null;
      }
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      renderer.domElement.removeEventListener("click", handlePointerClick);
      resizeObserver.disconnect();
      controls.dispose();
      graphRendererRef.current?.dispose();
      scene.remove(shell);
      disposeObject(shell);
      const spine = spineColumnRef.current;
      if (spine) {
        scene.remove(spine.group);
        spine.dispose();
        spineColumnRef.current = null;
      }
      const pointCloud = pointCloudRef.current;
      if (pointCloud) {
        scene.remove(pointCloud);
        disposeObject(pointCloud);
      }
      pointCloudMaterialRef.current = null;
      ambientBus.dispose();
      ambientBusRef.current = null;
      bloomPass.dispose();
      bloomPassRef.current = null;
      composer.dispose();
      composerRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
      if (sceneApiRef) {
        sceneApiRef.current = null;
      }
    };
  }, [onRegionSelect]);

  // Settings → Scene → glow intensity. Runs once after mount too, so the
  // persisted preference replaces the constructor default without rebuilding.
  useEffect(() => {
    if (bloomPassRef.current) {
      bloomPassRef.current.strength = uiPrefs.bloomStrength;
    }
  }, [uiPrefs.bloomStrength]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }

    // Clean up previous renderer
    const previousRenderer = graphRendererRef.current;
    if (previousRenderer) {
      scene.remove(previousRenderer.group);
      previousRenderer.dispose();
    }

    // Clean up previous visual effects
    const prevEffects = visualEffectsRef.current;
    if (prevEffects) {
      scene.remove(prevEffects.group);
      prevEffects.dispose();
      visualEffectsRef.current = null;
    }

    // Engine selection (Phase 4): the spiking substrate (AdvancedBrainCore,
    // aliased as SpikingEngine) is the DEFAULT on GPU-capable hardware; software
    // WebGL falls back to SignalSimulation (see resolveEngineChoice /
    // spikingCapability.ts). The hybrid cognitive engine (System 1 spiking +
    // System 2 reasoning + RL + meta-learning) is opt-in via ?useHybrid=true and
    // WRAPS AdvancedBrainCore, so it implies the spiking substrate + advanced
    // visual-effects pipeline.
    const { spiking: useSpikingEngine, hybrid: useHybridEngine } = resolveEngineChoice();
    // Binary engine-decision observable — the Phase 4 runtime check asserts spiking
    // actually ENGAGED under VERIFY_GPU=1 (and that the software-renderer smoke
    // stays on "signal"). Exposed BOTH as a console.info and a `window.__brainEngine`
    // global: console.info never trips the smoke's console.error counter, and the
    // global is readable by a CDP probe (page console.info is not surfaced through
    // verify-canvas's Log.entryAdded hook).
    const engineName = useHybridEngine ? "hybrid" : useSpikingEngine ? "spiking" : "signal";
    console.info(`[BrainScene] simulation engine: ${engineName}`);
    if (typeof window !== "undefined") {
      (window as unknown as { __brainEngine?: string }).__brainEngine = engineName;
    }

    // NOTE: do NOT force containerRef.style.position = "relative" here. The
    // .brain-scene rule is `position: absolute; inset: 0`, which both fills the
    // parent AND already establishes a containing block for absolutely-positioned
    // debug overlays. Overriding it to "relative" drops the inset:0 sizing
    // (relative + inset only offsets, never stretches), collapsing the container —
    // and the canvas's height:100% — to zero. That was the spiking-only h:0 bug.

    const performanceManager = performanceManagerRef.current;
const adjustedDensity = performanceManager
    ? performanceManager.getAdjustedDensity(neuronDensity)
    : neuronDensity;
    const graph = generateNeuralGraph({
      density: adjustedDensity,
      seed: Math.round(adjustedDensity * 1000) + 19,
    });
    
    // Create renderer and simulation. Phase 4 (improvement plan §1B): when the
    // spiking/hybrid engine is selected, BrainVisualEffects will swap in a
    // shader material that reads its own per-instance attributes — so the
    // renderer can short-circuit its expensive per-frame instanceColor +
    // instanceMatrix rewrites in `update()`. Flagging it at construction lets
    // the geometry build with the matching `aScale` attribute.
    const graphRenderer = new NeuralGraphRenderer(graph, performanceManagerRef.current, {
      colorMode: useSpikingEngine ? "shader" : "legacy",
    });
    graphRenderer.applyRegionVisibility(visibilityRef.current);
    graphRendererRef.current = graphRenderer;
    scene.add(graphRenderer.group);

    const simulation: SimulationLike = useHybridEngine
      ? new HybridCognitiveCore(graph, selectedActionId, {
          density: adjustedDensity,
          seed: Math.round(adjustedDensity * 1000) + 19,
        })
      : useSpikingEngine
        ? new SpikingEngine(graph, selectedActionId)
        : new SignalSimulation(graph, selectedActionId);

    simulation.setRunning(simulationRunning);
    simulation.setSpeed(signalSpeed);
    const adjustedMaxPulses = performanceManager
      ? performanceManager.getAdjustedMaxPulses(perfPresetRef.current.maxPulses)
      : perfPresetRef.current.maxPulses;
    simulation.setMaxPulses(adjustedMaxPulses);
    simulationRef.current = simulation;

    // Phase 4 — wire the MemoryBrainBridge to the PLAIN spiking engine. (Hybrid
    // owns its own memory subsystem and is NOT an `instanceof SpikingEngine`.)
    // The bridge auto-subscribes to the WS pipeline bus, so a cited memory from
    // any /api/ask becomes a biologically-routed region flash (hippocampus for
    // episodic recall, temporal cortex for semantic, etc.). Ticked in the render
    // loop and disposed alongside the simulation below.
    if (simulation instanceof SpikingEngine) {
      memoryBridgeRef.current = new MemoryBrainBridge(simulation);
    }

    // Create advanced visual effects (spiking engine only)
    if (useSpikingEngine) {
      const visualEffects = new BrainVisualEffects(graph, simulation, {
        enableNeuromodTint: true,
        enableNeurotransmitterParticles: true,
        enableRegionBreathing: true,
        enablePulseTrails: true,
        enableSpikeRaster: true, // Enable spike raster
      });
      visualEffectsRef.current = visualEffects;
      scene.add(visualEffects.group);

      // Apply visual effects to the graph renderer
      applyVisualEffectsToGraph(graphRenderer, visualEffects);

      // For production, create a secondary composer for post-processing
      if (composerRef.current) {
        visualEffects.attachToComposer(composerRef.current);
      }
      
      // Add debug UI (the spike-raster debug panel ships in the optional spike
      // extension; guard so a build without it doesn't crash on mount)
      const dbgEffects = visualEffects as Partial<{ addDebugControls: (el: HTMLElement) => void }>;
      if (containerRef.current && typeof dbgEffects.addDebugControls === "function") {
        dbgEffects.addDebugControls(containerRef.current);
      }
    }

    // Stash the interactive graph's metrics so the field-build effect (below)
    // can report the COMBINED neuron total. The neuron count the status bar
    // shows is the clickable graph PLUS the GPU field.
    graphMetricsRef.current = {
      neurons: graph.nodes.length,
      pathways: graph.pathways.length,
      regions: graph.regionOrder.length,
    };
    onMetricsChange({
      neurons: graph.nodes.length + (neuronFieldRef.current?.count ?? 0),
      pathways: graph.pathways.length,
      regions: graph.regionOrder.length,
    });

    // Dispose the simulation on rebuild/unmount. Matters for HybridCognitiveCore,
    // which unsubscribes from the WS bus and flushes its learned snapshot here.
    return () => {
      // Phase 4 — tear the memory bridge down FIRST so it unsubscribes from the
      // WS bus before the engine it flashes is disposed (no flash on a dead engine).
      memoryBridgeRef.current?.dispose();
      memoryBridgeRef.current = null;
      const disposable = simulation as { dispose?: () => void };
      if (typeof disposable.dispose === "function") disposable.dispose();
      // Dispose the advanced visual-effects pipeline (spiking/hybrid mode) too.
      // Without this the last BrainVisualEffects instance — its geometries,
      // shader materials and WS subscriptions — leaked on unmount: the
      // mount-effect cleanup has no reference to it, and the per-density cleanup
      // above only runs on the NEXT density change. No-op in default mode where
      // the ref is null.
      const effects = visualEffectsRef.current;
      if (effects) {
        scene.remove(effects.group);
        effects.dispose();
        visualEffectsRef.current = null;
      }
    };
    // Intentionally only depend on neuronDensity (and the stable metrics setter):
    // action/speed/running/visibility changes are handled by the small effects
    // above so we don't rebuild the whole graph on every slider tick. Latest
    // values are picked up via closure capture when density does change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neuronDensity, onMetricsChange]);

  // ─── The million-neuron field ──────────────────────────────────────────────
  // A GPU point cloud (NeuronField) rendered alongside the interactive graph,
  // driven each frame by the SAME region-intensity buffer (see renderFrame). It
  // is independent of the interactive graph, so it rebuilds ONLY when the target
  // size changes (a rare Settings tweak) — never on a density/action tick. The
  // count is capability-capped so a million points never tanks a software/
  // headless renderer.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    const previous = neuronFieldRef.current;
    if (previous) {
      scene.remove(previous.points);
      previous.dispose();
      neuronFieldRef.current = null;
    }

    const target = effectiveFieldCount(uiPrefs.neuronFieldCount);
    if (target > 0) {
      const field = new NeuronField({
        count: target,
        pixelRatio: Math.min(window.devicePixelRatio, perfPresetRef.current.dprCap),
      });
      neuronFieldRef.current = field;
      scene.add(field.points);
    }

    // Report the COMBINED neuron total (interactive graph + field).
    onMetricsChange({
      neurons: graphMetricsRef.current.neurons + (neuronFieldRef.current?.count ?? 0),
      pathways: graphMetricsRef.current.pathways,
      regions: graphMetricsRef.current.regions,
    });

    return () => {
      const field = neuronFieldRef.current;
      if (field) {
        sceneRef.current?.remove(field.points);
        field.dispose();
        neuronFieldRef.current = null;
      }
    };
  }, [uiPrefs.neuronFieldCount, onMetricsChange]);

  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }

    const preset = getCameraPreset(cameraPreset.mode);
    transitionRef.current = {
      startTime: performance.now() / 1000,
      duration: cameraPreset.mode === "inside" ? 0.9 : 0.75,
      startPosition: camera.position.clone(),
      endPosition: preset.position,
      startTarget: controls.target.clone(),
      endTarget: preset.target,
    };
  }, [cameraPreset]);

  return (
  <div className="brain-scene" ref={containerRef}>
    {showEmergentControls && (
      <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 100 }}> 
        <EmergentBehaviorControls
          onActionSelect={onActionSelect ?? (() => {})}
          currentAction={selectedActionId}
        />
      </div>
    )}
  </div>
);
}

// Clamp the requested neuron-field size to what the renderer can actually draw.
// GPU-capable hardware (the same gate that turns the spiking substrate on) gets
// the full requested count up to a sane ceiling; a software / SwiftShader
// renderer (headless verify:canvas smokes, weak GPUs) is held to a modest count
// so a million-point cloud can never blank the canvas or stall the render check.
function effectiveFieldCount(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) {
    return 0;
  }
  const capable = detectSpikingCapability();
  const cap = capable ? 2_000_000 : 50_000;
  return Math.min(Math.floor(requested), cap);
}

function getCameraPreset(mode: CameraPresetRequest["mode"]): {
  position: THREE.Vector3;
  target: THREE.Vector3;
} {
  if (mode === "inside") {
    return {
      position: new THREE.Vector3(0.04, 0.02, 0.18),
      target: new THREE.Vector3(0.02, 0.12, -0.78),
    };
  }

  if (mode === "reset") {
    return {
      position: new THREE.Vector3(2.9, 1.25, 3.2),
      target: new THREE.Vector3(0, -0.04, -0.04),
    };
  }

  return {
    position: new THREE.Vector3(0.1, 0.12, 4.25),
    target: new THREE.Vector3(0, 0, 0),
  };
}

function updateCameraTransition(
  _elapsedSeconds: number,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  transitionRef: React.MutableRefObject<CameraTransition | null>,
): void {
  const transition = transitionRef.current;
  if (!transition) {
    return;
  }

  const now = performance.now() / 1000;
  const progress = Math.min(1, (now - transition.startTime) / transition.duration);
  const eased = 1 - Math.pow(1 - progress, 3);
  camera.position.lerpVectors(transition.startPosition, transition.endPosition, eased);
  controls.target.lerpVectors(transition.startTarget, transition.endTarget, eased);

  if (progress >= 1) {
    transitionRef.current = null;
  }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((entry) => {
    const mesh = entry as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }

    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}

