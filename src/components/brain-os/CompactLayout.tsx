import { useState, useCallback, useRef, useEffect } from "react";
import {
  ChevronLeft, ChevronRight, Settings2, Activity, Brain,
  Maximize2, Minimize2, Focus
} from "lucide-react";
import type { BrainMetrics, BrainRegionId, RegionVisibility, BrainActionId, CameraPresetRequest } from "../../engine/types";
import type { PerfPreset, PerfMode } from "../../engine/performancePresets";
import type { AiPickEvent } from "../AiPickOverlay";
import type { AnatomyLoadProgress } from "../BrainScene";
import { UnifiedPanel } from "../UnifiedPanel";
import { PipelineOverlay } from "../PipelineOverlay";
import { LogicalRegionIndicator } from "../LogicalRegionIndicator";
import { AiPickOverlay } from "../AiPickOverlay";
import { BrainScene } from "../BrainScene";
import type { LayoutMode } from "../../engine/useLayoutMode";

interface CompactLayoutProps {
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
  onRunningChange: (v: boolean) => void;
  onActionChange: (id: BrainActionId) => void;
  onShellTransparentChange: (v: boolean) => void;
  onSignalSpeedChange: (v: number) => void;
  onNeuronDensityChange: (v: number | null) => void;
  onAnatomyVisibleChange: (v: boolean) => void;
  onAnatomyOpacityChange: (v: number) => void;
  onAudioEnabledChange: (v: boolean) => void;
  onRegionSelect: (id: BrainRegionId | null) => void;
  onRegionVisibilityChange: (id: BrainRegionId, v: boolean) => void;
  onCameraPreset: (mode: CameraPresetRequest["mode"]) => void;
  shellOpacity: number;
  perfPreset: PerfPreset;
  perfMode: PerfMode;
  effectiveTier: "light" | "balanced" | "cinematic";
  aiPick: AiPickEvent | null;
  onAnatomyLoadProgress: (p: AnatomyLoadProgress) => void;
  onMetricsChange: (m: BrainMetrics) => void;
  cameraPreset: CameraPresetRequest;
  metrics: BrainMetrics;
  currentLayout: LayoutMode;
  onLayoutChange: (l: LayoutMode) => void;
  onCycleLayout: () => void;
  onCyclePreset: () => void;
  modelName?: string;
}

const QuickActions = [
  { action: "lift-hand", label: "Lift Hand", key: "1" },
  { action: "touch-nose", label: "Touch Nose", key: "2" },
  { action: "look-left", label: "Look Left", key: "3" },
  { action: "reach-forward", label: "Reach Fwd", key: "4" },
  { action: "walk", label: "Walk", key: "5" },
  { action: "run", label: "Run", key: "6" },
  { action: "think", label: "Think", key: "7" },
] as const;

export function CompactLayout({
  running, selectedActionId, shellTransparent, signalSpeed, neuronDensity,
  anatomyVisible, anatomyOpacity, audioEnabled, regionVisibility, selectedRegionId,
  onRunningChange, onActionChange, onShellTransparentChange, onSignalSpeedChange,
  onNeuronDensityChange, onAnatomyVisibleChange, onAnatomyOpacityChange,
  onAudioEnabledChange, onRegionSelect, onRegionVisibilityChange, onCameraPreset,
  shellOpacity, perfPreset, perfMode, effectiveTier, aiPick,
  onAnatomyLoadProgress, onMetricsChange, cameraPreset, metrics,
  currentLayout, onLayoutChange, onCycleLayout, onCyclePreset,
  modelName = "Local Ollama",
}: CompactLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"actions" | "regions">("actions");
  const toggleSidebar = useCallback(() => setSidebarCollapsed(c => !c), []);

  return (
    <div className="compact-layout" data-layout={currentLayout}>
      {/* Top Status Bar */}
      <header className="compact-status-bar">
        <div className="status-bar-left">
          <Brain size={14} className="status-icon" />
          <span className="status-model">{modelName}</span>
          <span className="status-divider" />
          <span className="status-quality">
            {perfMode === "auto" ? "Auto·Balanced" : perfPreset.label}
          </span>
        </div>
        <div className="status-bar-center">
          <button
            className="layout-mode-btn"
            onClick={onCycleLayout}
            title="Switch layout mode"
          >
            {currentLayout === "compact" ? "Compact" : currentLayout === "focus" ? "Focus" : "Full"}
            <span className="layout-hint">L</span>
          </button>
        </div>
        <div className="status-bar-right">
          <span className="status-fps" title="FPS">
            <Activity size={12} />
            {metrics.fps} fps
          </span>
          <span className="status-mem" title="Memory points">
            <Brain size={12} />
            {(metrics.mem ?? 0).toLocaleString()}
          </span>
          <button
            className="preset-btn"
            onClick={onCyclePreset}
            title="Performance preset (P)"
          >
            {perfMode === "auto" ? `Auto·${effectiveTier}` : perfPreset.label}
          </button>
        </div>
      </header>

      {/* Main content area */}
      <div className="compact-main">
        {/* Collapsible Left Sidebar */}
        <aside className={`compact-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${sidebarTab === "actions" ? "active" : ""}`}
              onClick={() => setSidebarTab("actions")}
            >
              Actions
            </button>
            <button
              className={`sidebar-tab ${sidebarTab === "regions" ? "active" : ""}`}
              onClick={() => setSidebarTab("regions")}
            >
              Regions
            </button>
          </div>

          {!sidebarCollapsed && (
            <div className="sidebar-content">
              {sidebarTab === "actions" ? (
                <div className="quick-actions-grid">
                  {QuickActions.map((qa) => (
                    <button
                      key={qa.action}
                      className={`quick-action-btn ${selectedActionId === qa.action ? "active" : ""}`}
                      onClick={() => onActionChange(qa.action as BrainActionId)}
                      title={`${qa.label} (${qa.key})`}
                    >
                      {qa.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="region-quick-list">
                  {Object.entries(regionVisibility).map(([id, visible]) => (
                    <label key={id} className="region-toggle-row">
                      <input
                        type="checkbox"
                        checked={visible}
                        onChange={(e) => onRegionVisibilityChange(id as BrainRegionId, e.target.checked)}
                      />
                      <span className="region-label">{id.replace(/-/g, " ")}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            className="sidebar-toggle-btn"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </aside>

        {/* Brain Viewer */}
        <div className="compact-brain-viewer">
          <BrainScene
            aiPick={aiPick}
            anatomyOpacity={anatomyOpacity}
            anatomyVisible={anatomyVisible}
            audioEnabled={audioEnabled}
            cameraPreset={cameraPreset}
            neuronDensity={neuronDensity}
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

        {/* Chat Panel */}
        <div className="compact-chat-panel">
          <UnifiedPanel compactMode />
        </div>
      </div>

      {/* Bottom minimal bar */}
      <footer className="compact-bottom-bar">
        <button
          className="mode-exit-btn"
          onClick={onCycleLayout}
          title="Exit to full mode"
        >
          <Maximize2 size={14} />
          Full Mode
        </button>
      </footer>

      {/* Overlays */}
      <AiPickOverlay pick={aiPick} />
      <PipelineOverlay />
      <LogicalRegionIndicator />
    </div>
  );
}