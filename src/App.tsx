import { useCallback, useMemo, useState } from "react";
import { BrainScene } from "./components/BrainScene";
import { InfoPanel } from "./components/InfoPanel";
import { RegionControls } from "./components/RegionControls";
import { REGION_DEFINITIONS } from "./data/regionDefinitions";
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
  const [selectedRegionId, setSelectedRegionId] = useState<BrainRegionId | null>("motor");
  const [metrics, setMetrics] = useState<BrainMetrics>({
    neurons: 0,
    pathways: 0,
    regions: REGION_DEFINITIONS.length,
  });
  const [cameraPreset, setCameraPreset] = useState<CameraPresetRequest>({
    mode: "overview",
    sequence: 0,
  });

  const shellOpacity = shellTransparent ? 0.13 : 0.42;

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
        cameraPreset={cameraPreset}
        neuronDensity={neuronDensity}
        onMetricsChange={setMetrics}
        onRegionSelect={setSelectedRegionId}
        regionVisibility={sceneVisibility}
        selectedActionId={selectedActionId}
        selectedRegionId={selectedRegionId}
        shellOpacity={shellOpacity}
        signalSpeed={signalSpeed}
        simulationRunning={running}
      />
      <div className="scan-grid" aria-hidden="true" />
      <RegionControls
        neuronDensity={neuronDensity}
        onActionChange={setSelectedActionId}
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
    </main>
  );
}

export default App;
