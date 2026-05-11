import {
  Activity,
  Brain,
  Eye,
  Gauge,
  Layers3,
  MousePointer2,
  Pause,
  Play,
  Rotate3D,
  ScanEye,
  Zap,
} from "lucide-react";
import { BRAIN_ACTIONS, REGION_DEFINITIONS } from "../data/regionDefinitions";
import { getEstimatedNeuronCount } from "../engine/neuralGraphGenerator";
import type {
  BrainActionId,
  BrainRegionId,
  CameraPresetRequest,
  RegionVisibility,
} from "../engine/types";

interface RegionControlsProps {
  running: boolean;
  selectedActionId: BrainActionId;
  shellTransparent: boolean;
  signalSpeed: number;
  neuronDensity: number;
  regionVisibility: RegionVisibility;
  selectedRegionId: BrainRegionId | null;
  onRunningChange: (running: boolean) => void;
  onActionChange: (actionId: BrainActionId) => void;
  onShellTransparentChange: (transparent: boolean) => void;
  onSignalSpeedChange: (speed: number) => void;
  onNeuronDensityChange: (density: number) => void;
  onRegionVisibilityChange: (regionId: BrainRegionId, visible: boolean) => void;
  onRegionSelect: (regionId: BrainRegionId) => void;
  onCameraPreset: (mode: CameraPresetRequest["mode"]) => void;
}

export function RegionControls({
  running,
  selectedActionId,
  shellTransparent,
  signalSpeed,
  neuronDensity,
  regionVisibility,
  selectedRegionId,
  onRunningChange,
  onActionChange,
  onShellTransparentChange,
  onSignalSpeedChange,
  onNeuronDensityChange,
  onRegionVisibilityChange,
  onRegionSelect,
  onCameraPreset,
}: RegionControlsProps): JSX.Element {
  return (
    <aside className="control-panel" aria-label="Brain simulation controls">
      <header className="panel-heading">
        <div className="brand-mark">
          <Brain size={22} />
        </div>
        <div>
          <p className="eyebrow">Neural X-ray prototype</p>
          <h1>Virtual Brain Engine</h1>
        </div>
      </header>

      <section className="control-section transport-row">
        <button
          className="primary-control"
          type="button"
          onClick={() => onRunningChange(!running)}
        >
          {running ? <Pause size={18} /> : <Play size={18} />}
          <span>{running ? "Stop simulation" : "Start simulation"}</span>
        </button>
        <div className={running ? "status-chip live" : "status-chip"}>
          <Activity size={15} />
          <span>{running ? "Live" : "Paused"}</span>
        </div>
      </section>

      <section className="control-section">
        <div className="section-title">
          <Zap size={16} />
          <span>Brain action</span>
        </div>
        <div className="action-grid">
          {BRAIN_ACTIONS.map((action) => (
            <button
              className={action.id === selectedActionId ? "action-button active" : "action-button"}
              key={action.id}
              type="button"
              onClick={() => onActionChange(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>

      <section className="control-section">
        <div className="section-title">
          <Rotate3D size={16} />
          <span>View</span>
        </div>
        <div className="segmented">
          <button type="button" onClick={() => onCameraPreset("overview")}>
            <ScanEye size={15} />
            <span>Orbit</span>
          </button>
          <button type="button" onClick={() => onCameraPreset("inside")}>
            <MousePointer2 size={15} />
            <span>Inside</span>
          </button>
          <button type="button" onClick={() => onCameraPreset("reset")}>
            <Rotate3D size={15} />
            <span>Reset</span>
          </button>
        </div>
      </section>

      <section className="control-section sliders">
        <label className="toggle-row">
          <span>
            <Eye size={16} />
            X-ray shell
          </span>
          <input
            type="checkbox"
            checked={shellTransparent}
            onChange={(event) => onShellTransparentChange(event.target.checked)}
          />
        </label>

        <label className="range-control">
          <span>
            <Gauge size={16} />
            Signal speed
            <output>{signalSpeed.toFixed(1)}x</output>
          </span>
          <input
            min="0.3"
            max="3.2"
            step="0.1"
            type="range"
            value={signalSpeed}
            onChange={(event) => onSignalSpeedChange(Number(event.target.value))}
          />
        </label>

        <label className="range-control">
          <span>
            <Layers3 size={16} />
            Neuron density
            <output>{getEstimatedNeuronCount(neuronDensity).toLocaleString()}</output>
          </span>
          <input
            min="0.8"
            max="2.8"
            step="0.1"
            type="range"
            value={neuronDensity}
            onChange={(event) => onNeuronDensityChange(Number(event.target.value))}
          />
        </label>
      </section>

      <section className="control-section region-section">
        <div className="section-title">
          <Layers3 size={16} />
          <span>Regions</span>
        </div>
        <div className="region-list">
          {REGION_DEFINITIONS.map((region) => (
            <div
              className={region.id === selectedRegionId ? "region-row selected" : "region-row"}
              key={region.id}
            >
              <button type="button" onClick={() => onRegionSelect(region.id)}>
                <span className="region-swatch" style={{ backgroundColor: region.color }} />
                <span>{region.shortName}</span>
              </button>
              <input
                aria-label={`Toggle ${region.name}`}
                checked={regionVisibility[region.id]}
                type="checkbox"
                onChange={(event) => onRegionVisibilityChange(region.id, event.target.checked)}
              />
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}
