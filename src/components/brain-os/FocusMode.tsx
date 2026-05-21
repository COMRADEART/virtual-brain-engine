import type { BrainMetrics, BrainRegionId, RegionVisibility, BrainActionId, CameraPresetRequest } from "../../engine/types";
import type { PerfPreset } from "../../engine/performancePresets";
import type { AiPickEvent } from "../AiPickOverlay";
import type { AnatomyLoadProgress } from "../BrainScene";
import { UnifiedPanel } from "../UnifiedPanel";
import { BrainScene } from "../BrainScene";
import { X, Brain, Activity, ChevronDown } from "lucide-react";

interface FocusModeProps {
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
  shellOpacity: number;
  perfPreset: PerfPreset;
  aiPick: AiPickEvent | null;
  onAnatomyLoadProgress: (p: AnatomyLoadProgress) => void;
  onMetricsChange: (m: BrainMetrics) => void;
  cameraPreset: CameraPresetRequest;
  onRegionSelect: (id: BrainRegionId | null) => void;
  onExitFocus: () => void;
  metrics: BrainMetrics;
}

export function FocusMode({
  running, selectedActionId, shellTransparent, signalSpeed, neuronDensity,
  anatomyVisible, anatomyOpacity, audioEnabled, regionVisibility, selectedRegionId,
  shellOpacity, perfPreset, aiPick, onAnatomyLoadProgress, onMetricsChange,
  cameraPreset, onRegionSelect, onExitFocus, metrics,
}: FocusModeProps) {
  return (
    <div className="focus-mode" data-layout="focus">
      {/* Exit button */}
      <button
        className="focus-exit-btn"
        onClick={onExitFocus}
        title="Exit Focus Mode (F11 or Ctrl+Shift+F)"
      >
        <X size={14} />
        Exit Focus
      </button>

      {/* Minimal status badge */}
      <div className="focus-status-badge">
        <Brain size={12} />
        <span>{metrics.neurons.toLocaleString()}n</span>
        <span className="focus-divider">·</span>
        <Activity size={12} />
        <span>{metrics.fps} fps</span>
      </div>

      {/* Main chat area - takes full viewport */}
      <div className="focus-main">
        <UnifiedPanel compactMode focusMode />
      </div>

      {/* Brain preview - bottom right corner */}
      <div className="focus-brain-preview" title="Brain activity preview">
        <BrainScene
          aiPick={aiPick}
          anatomyOpacity={anatomyOpacity}
          anatomyVisible={anatomyVisible}
          audioEnabled={audioEnabled}
          cameraPreset={cameraPreset}
          neuronDensity={neuronDensity * 0.5}
          onAnatomyLoadProgress={onAnatomyLoadProgress}
          onMetricsChange={onMetricsChange}
          onRegionSelect={(id) => onRegionSelect(id as BrainRegionId)}
          perfPreset={perfPreset}
          regionVisibility={regionVisibility}
          selectedActionId={selectedActionId}
          selectedRegionId={selectedRegionId}
          shellOpacity={shellOpacity}
          signalSpeed={signalSpeed}
          simulationRunning={running}
        />
      </div>
    </div>
  );
}