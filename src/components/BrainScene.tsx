import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createBrainShell, setBrainShellOpacity } from "./BrainShell";
import { NeuralGraphRenderer } from "./NeuralGraph";
import { generateNeuralGraph } from "../engine/neuralGraphGenerator";
import { SignalSimulation } from "../engine/signalSimulation";
import type {
  BrainActionId,
  BrainMetrics,
  BrainRegionId,
  CameraPresetRequest,
  RegionVisibility,
} from "../engine/types";

interface BrainSceneProps {
  simulationRunning: boolean;
  selectedActionId: BrainActionId;
  signalSpeed: number;
  neuronDensity: number;
  shellOpacity: number;
  regionVisibility: RegionVisibility;
  selectedRegionId: BrainRegionId | null;
  cameraPreset: CameraPresetRequest;
  onRegionSelect: (regionId: BrainRegionId) => void;
  onMetricsChange: (metrics: BrainMetrics) => void;
}

interface CameraTransition {
  startTime: number;
  duration: number;
  startPosition: THREE.Vector3;
  endPosition: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
}

export function BrainScene({
  simulationRunning,
  selectedActionId,
  signalSpeed,
  neuronDensity,
  shellOpacity,
  regionVisibility,
  selectedRegionId,
  cameraPreset,
  onRegionSelect,
  onMetricsChange,
}: BrainSceneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const shellRef = useRef<THREE.Group | null>(null);
  const graphRendererRef = useRef<NeuralGraphRenderer | null>(null);
  const simulationRef = useRef<SignalSimulation | null>(null);
  const transitionRef = useRef<CameraTransition | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const selectedRegionRef = useRef(selectedRegionId);
  const visibilityRef = useRef(regionVisibility);

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

  useEffect(() => {
    if (shellRef.current) {
      setBrainShellOpacity(shellRef.current, shellOpacity);
    }
  }, [shellOpacity]);

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

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

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

    const shell = createBrainShell({ opacity: shellOpacity });
    shellRef.current = shell;
    scene.add(shell);

    const clock = new THREE.Clock();
    let animationFrame = 0;

    const renderFrame = () => {
      animationFrame = window.requestAnimationFrame(renderFrame);
      const delta = Math.min(clock.getDelta(), 0.033);
      const elapsed = clock.elapsedTime;
      const simulation = simulationRef.current;
      const graphRenderer = graphRendererRef.current;

      updateCameraTransition(elapsed, camera, controls, transitionRef);

      if (simulation && graphRenderer) {
        simulation.step(delta, elapsed);
        graphRenderer.update(
          simulation,
          visibilityRef.current,
          selectedRegionRef.current,
          elapsed,
        );
      }

      controls.update();
      renderer.render(scene, camera);
    };

    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
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
      window.cancelAnimationFrame(animationFrame);
      renderer.domElement.removeEventListener("click", handlePointerClick);
      resizeObserver.disconnect();
      controls.dispose();
      graphRendererRef.current?.dispose();
      scene.remove(shell);
      disposeObject(shell);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [onRegionSelect, shellOpacity]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }

    const previousRenderer = graphRendererRef.current;
    if (previousRenderer) {
      scene.remove(previousRenderer.group);
      previousRenderer.dispose();
    }

    const graph = generateNeuralGraph({
      density: neuronDensity,
      seed: Math.round(neuronDensity * 1000) + 19,
    });
    const graphRenderer = new NeuralGraphRenderer(graph);
    graphRenderer.applyRegionVisibility(regionVisibility);
    graphRendererRef.current = graphRenderer;
    scene.add(graphRenderer.group);

    const simulation = new SignalSimulation(graph, selectedActionId);
    simulation.setRunning(simulationRunning);
    simulation.setSpeed(signalSpeed);
    simulationRef.current = simulation;

    onMetricsChange({
      neurons: graph.nodes.length,
      pathways: graph.pathways.length,
      regions: graph.regionOrder.length,
    });
  }, [
    neuronDensity,
    onMetricsChange,
    regionVisibility,
    selectedActionId,
    signalSpeed,
    simulationRunning,
  ]);

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

  return <div className="brain-scene" ref={containerRef} />;
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
  elapsedSeconds: number,
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
