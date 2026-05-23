import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { createBrainShell, setBrainShellOpacity } from "./BrainShell";
import { NeuralGraphRenderer } from "./NeuralGraph";
import type { AiPickEvent } from "./AiPickOverlay";
import { ACTION_BY_ID } from "../engine/brainRegions";
import { createAmbientBus, type AmbientBus } from "../engine/audioBus";
import { generateNeuralGraph } from "../engine/neuralGraphGenerator";
import { SignalSimulation } from "../engine/signalSimulation";
import { SpikingEngine } from "../engine/SpikingEngine";
import {
  BrainVisualEffects,
  applyVisualEffectsToGraph,
} from "../engine/BrainVisualEffects";

// ─── Engine toggle ────────────────────────────────────────────────────────
// Flip to false to use the lightweight SignalSimulation instead of LIF neurons.
// Currently false: the LIF SpikingEngine rewrite blocks the main thread on
// mount (the scene never paints). SignalSimulation is the stable engine; the
// SpikingEngine path must be profiled/fixed before re-enabling.
const USE_SPIKING_ENGINE = false;
type SimulationLike = SignalSimulation | SpikingEngine;
import { subscribeBrainBus } from "../engine/brainBus";
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
  aiPick: AiPickEvent | null;
  audioEnabled: boolean;
  perfPreset: PerfPreset;
  showEmergentControls?: boolean;
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
  aiPick,
  audioEnabled,
  perfPreset,
  showEmergentControls,
  onRegionSelect,
  onActionSelect,
  onMetricsChange,
  onAnatomyLoadProgress,
}: BrainSceneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const shellRef = useRef<THREE.Group | null>(null);
  const graphRendererRef = useRef<NeuralGraphRenderer | null>(null);
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

  // When the AI picks an action, stamp a transient "flash" onto the regions in
  // that action's network. The sequence field bumps on every pick so we re-flash
  // even if the same action is picked twice in a row.
  useEffect(() => {
    if (!aiPick) {
      return;
    }
    const action = ACTION_BY_ID[aiPick.action];
    if (!action) {
      return;
    }
    simulationRef.current?.flashRegions(action.activeRegions);
  }, [aiPick]);

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

    const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.01, 90);
    camera.position.set(0.1, 0.12, 4.25);
    cameraRef.current = camera;

    // Initialize performance manager and set camera
    const performanceManager = new PerformanceManager();
    performanceManager.setCamera(camera);
    performanceManagerRef.current = performanceManager;

    // Determine if we should use the advanced SpikingEngine
    const useSpikingEngine = window.location.search.includes("useSpiking=true") || USE_SPIKING_ENGINE;
    void useSpikingEngine;
    
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

    // Pause simulation when the tab is hidden to save GPU/CPU.
    const handleVisibilityChange = () => {
      simulationRef.current?.setRunning(!document.hidden);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

const renderFrame = () => {
    animationFrame = window.requestAnimationFrame(renderFrame);
    const delta = Math.min(clock.getDelta(), 0.033);
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
      
      // Update graph renderer
      graphRenderer.update(
        simulation,
        visibilityRef.current,
        selectedRegionRef.current,
        elapsed,
      );
      
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
        
        // Update neuron-specific attributes if using SpikingEngine
        if (simulation instanceof SpikingEngine) {
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
  
  // Debug controls for testing visualizations
  const handleDebugCommand = (key: string) => {
    const visualEffects = visualEffectsRef.current;
    if (!visualEffects) return;
    
    switch (key) {
      case "1": // Test dopamine
        visualEffects.setNeuromodulators({ dopamine: 0.8 });
        break;
      case "2": // Test acetylcholine
        visualEffects.setNeuromodulators({ acetylcholine: 0.8 });
        break;
      case "3": // Test serotonin
        visualEffects.setNeuromodulators({ serotonin: 0.7 });
        break;
      case "4": // Test norepinephrine
        visualEffects.setNeuromodulators({ norepinephrine: 0.6 });
        break;
      case "5": // Test working memory
        visualEffects.visualizeWorkingMemory([
          "prefrontal-l", "prefrontal-r", 
          "parietal-l", "parietal-r",
          "temporal-l", "hippocampus-l"
        ], 0.9);
        break;
      case "6": // Show EEG overlay
        visualEffects.showEegOverlay(true);
        break;
      case "7": // Highlight rich-club hubs
        visualEffects.highlightRichClubHubs([
          "prefrontal-l", "prefrontal-r", 
          "parietal-l", "parietal-r", 
          "thalamus-l", "thalamus-r"
        ], 1.0);
        break;
      case "0": // Reset visualizations
        visualEffects.setNeuromodulators({});
        visualEffects.visualizeWorkingMemory([]);
        visualEffects.showEegOverlay(false);
        break;
    }
  };

    renderer.domElement.addEventListener("click", handlePointerClick);
    renderFrame();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      renderer.domElement.removeEventListener("click", handlePointerClick);
      resizeObserver.disconnect();
      controls.dispose();
      graphRendererRef.current?.dispose();
      scene.remove(shell);
      disposeObject(shell);
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
    };
  }, [onRegionSelect]);

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

    // Engine selection: the advanced AdvancedBrainCore (aliased as SpikingEngine)
    // is opt-in. Default stays SignalSimulation; append ?useSpiking=true to the
    // URL to drive the scene with the biologically-plausible engine live.
    const useSpikingEngine =
      USE_SPIKING_ENGINE ||
      (typeof window !== "undefined" && window.location.search.includes("useSpiking=true"));

    // Add spike raster container (if using the spiking engine)
    if (useSpikingEngine && containerRef.current) {
      containerRef.current.style.position = "relative";
    }

    const performanceManager = performanceManagerRef.current;
const adjustedDensity = performanceManager
    ? performanceManager.getAdjustedDensity(neuronDensity)
    : neuronDensity;
    const graph = generateNeuralGraph({
      density: adjustedDensity,
      seed: Math.round(adjustedDensity * 1000) + 19,
    });
    
    // Create renderer and simulation
    const graphRenderer = new NeuralGraphRenderer(graph, performanceManagerRef.current);
    graphRenderer.applyRegionVisibility(visibilityRef.current);
    graphRendererRef.current = graphRenderer;
    scene.add(graphRenderer.group);

    // Enable advanced visual effects if using spiking engine
    let simulation: SimulationLike;
    let visualEffects: BrainVisualEffects | null = null;

    simulation = useSpikingEngine
      ? new SpikingEngine(graph, selectedActionId)
      : new SignalSimulation(graph, selectedActionId);

    simulation.setRunning(simulationRunning);
    simulation.setSpeed(signalSpeed);
    const adjustedMaxPulses = performanceManager
      ? performanceManager.getAdjustedMaxPulses(perfPresetRef.current.maxPulses)
      : perfPresetRef.current.maxPulses;
    simulation.setMaxPulses(adjustedMaxPulses);
    simulationRef.current = simulation;

    // Create advanced visual effects
    if (useSpikingEngine) {
      visualEffects = new BrainVisualEffects(graph, simulation, {
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

    onMetricsChange({
      neurons: graph.nodes.length,
      pathways: graph.pathways.length,
      regions: graph.regionOrder.length,
    });
    // Intentionally only depend on neuronDensity (and the stable metrics setter):
    // action/speed/running/visibility changes are handled by the small effects
    // above so we don't rebuild the whole graph on every slider tick. Latest
    // values are picked up via closure capture when density does change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neuronDensity, onMetricsChange]);

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

