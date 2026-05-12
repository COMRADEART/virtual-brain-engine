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
  Sparkles,
  Volume2,
  Zap,
} from "lucide-react";
import { BRAIN_ACTIONS, REGION_DEFINITIONS } from "../data/regionDefinitions";
import { getEstimatedNeuronCount } from "../engine/neuralGraphGenerator";
import type {
  BrainActionId,
  BrainLobe,
  BrainRegionDefinition,
  BrainRegionId,
  CameraPresetRequest,
  RegionVisibility,
} from "../engine/types";

const LOBE_ORDER: BrainLobe[] = [
  "frontal",
  "parietal",
  "temporal",
  "occipital",
  "subcortical",
  "cerebellum",
  "brainstem",
];

const LOBE_LABELS: Record<BrainLobe, string> = {
  frontal: "Frontal",
  parietal: "Parietal",
  temporal: "Temporal",
  occipital: "Occipital",
  subcortical: "Subcortical",
  cerebellum: "Cerebellum",
  brainstem: "Brainstem",
};

const REGIONS_BY_LOBE: Array<{ lobe: BrainLobe; regions: BrainRegionDefinition[] }> = LOBE_ORDER
  .map((lobe) => ({
    lobe,
    regions: REGION_DEFINITIONS.filter((region) => region.lobe === lobe),
  }))
  .filter((group) => group.regions.length > 0);

interface RegionControlsProps {
  running: boolean;
  selectedActionId: BrainActionId;
  shellTransparent: boolean;
  signalSpeed: number;
  neuronDensity: number;
  anatomyVisible: boolean;
  anatomyOpacity: number;
  audioEnabled: boolean;
  regionVisibility: RegionVisibility;
  selectedRegionId: BrainRegionId | null;
  onRunningChange: (running: boolean) => void;
  onActionChange: (actionId: BrainActionId) => void;
  onShellTransparentChange: (transparent: boolean) => void;
  onSignalSpeedChange: (speed: number) => void;
  onNeuronDensityChange: (density: number) => void;
  onAnatomyVisibleChange: (visible: boolean) => void;
  onAnatomyOpacityChange: (opacity: number) => void;
  onAudioEnabledChange: (enabled: boolean) => void;
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
  anatomyVisible,
  anatomyOpacity,
  audioEnabled,
  regionVisibility,
  selectedRegionId,
  onRunningChange,
  onActionChange,
  onShellTransparentChange,
  onSignalSpeedChange,
  onNeuronDensityChange,
  onAnatomyVisibleChange,
  onAnatomyOpacityChange,
  onAudioEnabledChange,
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

        <label className="toggle-row">
          <span>
            <Sparkles size={16} />
            Anatomy cloud
          </span>
          <input
            type="checkbox"
            checked={anatomyVisible}
            onChange={(event) => onAnatomyVisibleChange(event.target.checked)}
          />
        </label>

        <label className="toggle-row">
          <span>
            <Volume2 size={16} />
            Ambient sound
          </span>
          <input
            type="checkbox"
            checked={audioEnabled}
            onChange={(event) => onAudioEnabledChange(event.target.checked)}
          />
        </label>

        <label className="range-control">
          <span>
            <Sparkles size={16} />
            Anatomy intensity
            <output>{Math.round(anatomyOpacity * 100)}%</output>
          </span>
          <input
            disabled={!anatomyVisible}
            min="0.05"
            max="1"
            step="0.05"
            type="range"
            value={anatomyOpacity}
            onChange={(event) => onAnatomyOpacityChange(Number(event.target.value))}
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
          {REGIONS_BY_LOBE.map((group) => (
            <div className="region-group" key={group.lobe}>
              <p className="region-group-label">{LOBE_LABELS[group.lobe]}</p>
              {group.regions.map((region) => (
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
          ))}
        </div>
      </section>
    </aside>
  );
}
