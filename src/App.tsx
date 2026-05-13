import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiPickOverlay, type AiPickEvent } from "./components/AiPickOverlay";
import { BrainOSPanel } from "./components/BrainOSPanel";
import { BrainScene, type AnatomyLoadProgress } from "./components/BrainScene";
import { InfoPanel } from "./components/InfoPanel";
import { LogicalRegionIndicator } from "./components/LogicalRegionIndicator";
import { PipelineOverlay } from "./components/PipelineOverlay";
import { RegionControls } from "./components/RegionControls";
import { REGION_DEFINITIONS, BRAIN_ACTIONS } from "./data/regionDefinitions";

// Lazy-load the AI panel so its chunk (plus the Ollama client and Web Speech
// wrapper) stay out of the initial bundle. The panel is non-critical and
// renders nothing until its module arrives.
const AiCompanion = lazy(() =>
  import("./components/AiCompanion").then((module) => ({ default: module.AiCompanion })),
);
import type {
  BrainActionId,
  BrainMetrics,
  BrainRegionId,
  CameraPresetRequest,
  RegionVisibility,
} from "./engine/types";
import "./styles.css";

const DEFAULT_VISIBILITY = REGION_DEFINITIONS.reduce((visibility, region) => {
  visibility[region.id] = true;
  return visibility;
}, {} as RegionVisibility);

function App(): JSX.Element {
  const [running, setRunning] = useState(true);
  const [selectedActionId, setSelectedActionId] = useState<BrainActionId>("lift-hand");
  const [shellTransparent, setShellTransparent] = useState(true);
  const [signalSpeed, setSignalSpeed] = useState(1.3);
  const [neuronDensity, setNeuronDensity] = useState(1);
  const [regionVisibility, setRegionVisibility] = useState<RegionVisibility>(DEFAULT_VISIBILITY);
  const [selectedRegionId, setSelectedRegionId] = useState<BrainRegionId | null>("motor-l");
  const [anatomyVisible, setAnatomyVisible] = useState(true);
  const [anatomyOpacity, setAnatomyOpacity] = useState(0.32);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [metrics, setMetrics] = useState<BrainMetrics>({
    neurons: 0,
    pathways: 0,
    regions: REGION_DEFINITIONS.length,
  });
  const [cameraPreset, setCameraPreset] = useState<CameraPresetRequest>({
    mode: "overview",
    sequence: 0,
  });
  const [aiPick, setAiPick] = useState<AiPickEvent | null>(null);
  const aiPickSequence = useRef(0);
  const [anatomyProgress, setAnatomyProgress] = useState<AnatomyLoadProgress>({
    loaded: 0,
    total: 0,
    done: false,
  });

  const shellOpacity = shellTransparent ? 0.02 : 0.08;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      switch (event.key) {
        case " ":
          event.preventDefault();
          setRunning((r) => !r);
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          const index = parseInt(event.key, 10) - 1;
          if (index < BRAIN_ACTIONS.length) {
            setSelectedActionId(BRAIN_ACTIONS[index].id);
          }
          break;
        }
        case "o":
        case "O":
          setCameraPreset((p) => ({ mode: "overview", sequence: p.sequence + 1 }));
          break;
        case "i":
        case "I":
          setCameraPreset((p) => ({ mode: "inside", sequence: p.sequence + 1 }));
          break;
        case "r":
        case "R":
          setCameraPreset((p) => ({ mode: "reset", sequence: p.sequence + 1 }));
          break;
        case "x":
        case "X":
          setShellTransparent((t) => !t);
          break;
        case "a":
        case "A":
          setAnatomyVisible((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleAiPick = useCallback((action: BrainActionId, why?: string) => {
    setSelectedActionId(action);
    aiPickSequence.current += 1;
    setAiPick({ action, why, sequence: aiPickSequence.current });
  }, []);

  const anatomyPercent = useMemo(() => {
    if (anatomyProgress.done) {
      return 100;
    }
    if (anatomyProgress.total > 0) {
      return Math.min(99, Math.round((anatomyProgress.loaded / anatomyProgress.total) * 100));
    }
    return null; // indeterminate — server didn't send content-length
  }, [anatomyProgress]);

  const handleRegionVisibilityChange = useCallback(
    (regionId: BrainRegionId, visible: boolean) => {
      setRegionVisibility((current) => ({
        ...current,
        [regionId]: visible,
      }));
    },
    [],
  );

  const handleCameraPreset = useCallback((mode: CameraPresetRequest["mode"]) => {
    setCameraPreset((current) => ({
      mode,
      sequence: current.sequence + 1,
    }));
  }, []);

  const sceneVisibility = useMemo(() => ({ ...regionVisibility }), [regionVisibility]);

  return (
    <main className="app-shell">
      <BrainScene
        aiPick={aiPick}
        anatomyOpacity={anatomyOpacity}
        anatomyVisible={anatomyVisible}
        audioEnabled={audioEnabled}
        cameraPreset={cameraPreset}
        neuronDensity={neuronDensity}
        onAnatomyLoadProgress={setAnatomyProgress}
        onMetricsChange={setMetrics}
        onRegionSelect={setSelectedRegionId}
        regionVisibility={sceneVisibility}
        selectedActionId={selectedActionId}
        selectedRegionId={selectedRegionId}
        shellOpacity={shellOpacity}
        signalSpeed={signalSpeed}
        simulationRunning={running}
      />
      {!anatomyProgress.done ? (
        <div className="anatomy-loading-pill" role="status" aria-live="polite">
          <span className="anatomy-loading-dot" aria-hidden="true" />
          <span>
            Loading anatomy{anatomyPercent !== null ? ` ${anatomyPercent}%` : "…"}
          </span>
        </div>
      ) : null}
      <div className="scan-grid" aria-hidden="true" />
      <RegionControls
        anatomyOpacity={anatomyOpacity}
        anatomyVisible={anatomyVisible}
        audioEnabled={audioEnabled}
        neuronDensity={neuronDensity}
        onActionChange={setSelectedActionId}
        onAnatomyOpacityChange={setAnatomyOpacity}
        onAnatomyVisibleChange={setAnatomyVisible}
        onAudioEnabledChange={setAudioEnabled}
        onCameraPreset={handleCameraPreset}
        onNeuronDensityChange={setNeuronDensity}
        onRegionSelect={setSelectedRegionId}
        onRegionVisibilityChange={handleRegionVisibilityChange}
        onRunningChange={setRunning}
        onShellTransparentChange={setShellTransparent}
        onSignalSpeedChange={setSignalSpeed}
        regionVisibility={regionVisibility}
        running={running}
        selectedActionId={selectedActionId}
        selectedRegionId={selectedRegionId}
        shellTransparent={shellTransparent}
        signalSpeed={signalSpeed}
      />
      <InfoPanel
        metrics={metrics}
        selectedActionId={selectedActionId}
        selectedRegionId={selectedRegionId}
      />
      <AiPickOverlay pick={aiPick} />
      <PipelineOverlay />
      <LogicalRegionIndicator />
      <BrainOSPanel />
      <Suspense fallback={null}>
        <AiCompanion onActionPick={handleAiPick} />
      </Suspense>
    </main>
  );
}

export default App;
