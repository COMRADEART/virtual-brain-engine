import { useMemo, type CSSProperties } from "react";
import { SystemMonitorWidget } from "./SystemMonitorWidget";
import { ActivityChartWidget } from "./ActivityChartWidget";
import { TasksWidget } from "./TasksWidget";
import { SignalLogWidget } from "./SignalLogWidget";
import { BrainScene } from "../BrainScene";
import type {
  BrainActionId,
  BrainRegionId,
  RegionVisibility,
  BrainMetrics,
  CameraPresetRequest,
} from "../../engine/types";
import { PERF_PRESETS } from "../../engine/performancePresets";

interface DashboardLayoutProps {
  running: boolean;
  selectedActionId: BrainActionId;
  selectedRegionId: BrainRegionId | null;
  regionVisibility: RegionVisibility;
  metrics: BrainMetrics & { fps: number };
  onRegionSelect: (id: BrainRegionId | null) => void;
  onActionSelect: (id: BrainActionId) => void;
  onMetricsChange: (metrics: BrainMetrics) => void;
}

export function DashboardLayout({
  running,
  selectedActionId,
  selectedRegionId,
  regionVisibility,
  metrics,
  onRegionSelect,
  onActionSelect,
  onMetricsChange
}: DashboardLayoutProps) {
  // Use a fixed cinematic preset for the dashboard center
  const preset = PERF_PRESETS.cinematic;

  // Stable reference: BrainScene's camera effect keys on this object, so a fresh
  // literal each render would re-fire the overview tween every time the
  // dashboard re-renders (fps/metrics ticks) and fight the user's orbit. Build
  // it once so the camera settles to overview and then stays user-controllable.
  const cameraPreset = useMemo<CameraPresetRequest>(
    () => ({ mode: "overview", sequence: 0 }),
    [],
  );

  // Activity sparkline: a lightweight flux visualisation seeded by the live
  // frame rate. It's illustrative motion, not a recorded time series.
  const activityData = useMemo(() =>
    Array.from({ length: 30 }, (_, i) => ({
      time: i,
      value: 10 + Math.random() * (metrics.fps > 0 ? metrics.fps : 60)
    }))
  , [metrics.fps]);

  // Honest render-health readout: frame rate against a 60 fps target. No
  // fabricated "cognitive stability" — this is the real, measured value.
  const renderHealth = Math.min(100, Math.max(0, Math.round((metrics.fps / 60) * 100)));

  return (
    <div className="dashboard-layout">
      {/* Left Sidebar */}
      <aside className="dashboard-sidebar left">
        <SystemMonitorWidget />
        <ActivityChartWidget data={activityData} title="Neural Signal Flux" hz={metrics.fps} />
        <div className="dashboard-widget quick-actions">
          <header className="widget-header"><h3 className="widget-title">Region Focus</h3></header>
          <div className="widget-body">
            <div className="region-badge-grid">
               {Object.entries(regionVisibility).slice(0, 12).map(([id, visible]) => (
                 <button 
                  key={id} 
                  className={`region-badge ${visible ? 'active' : ''} ${selectedRegionId === id ? 'selected' : ''}`}
                  onClick={() => onRegionSelect(id as BrainRegionId)}
                 >
                   {id.replace('-l', '').replace('-r', '').toUpperCase()}
                 </button>
               ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Center Area */}
      <main className="dashboard-center">
        <div className="scene-container">
          <BrainScene
            simulationRunning={running}
            selectedActionId={selectedActionId}
            selectedRegionId={selectedRegionId}
            regionVisibility={regionVisibility}
            onRegionSelect={onRegionSelect}
            onActionSelect={onActionSelect}
            perfPreset={preset}
            anatomyVisible={true}
            anatomyOpacity={0.15}
            shellOpacity={0.03}
            signalSpeed={1.3}
            neuronDensity={preset.density}
            cameraPreset={cameraPreset}
            audioEnabled={false}
            onMetricsChange={onMetricsChange}
          />
          <div className="center-hud">
             <div className="hud-metric">
                <small>NEURON POPULATION</small>
                <span>{metrics.neurons.toLocaleString()}</span>
             </div>
             <div className="hud-metric">
                <small>ACTIVE PATHWAYS</small>
                <span>{metrics.pathways.toLocaleString()}</span>
             </div>
             <div className="hud-metric">
                <small>RENDER HZ</small>
                <span>{metrics.fps}</span>
             </div>
          </div>
        </div>
      </main>

      {/* Right Sidebar */}
      <aside className="dashboard-sidebar right">
        <TasksWidget />
        <div className="dashboard-widget brain-health">
          <header className="widget-header"><h3 className="widget-title">Engine Health</h3></header>
          <div className="widget-body">
             <div className="health-stat">
                <div className="health-circle" style={{ "--percent": `${renderHealth}%` } as CSSProperties}>
                  <span>{renderHealth}%</span>
                </div>
                <div className="health-info">
                   <strong>Render Health</strong>
                   <p>{metrics.fps > 0 ? `${metrics.fps} fps vs 60 fps target` : "Awaiting frame metrics"}</p>
                </div>
             </div>
          </div>
        </div>
        <SignalLogWidget />
      </aside>
    </div>
  );
}
