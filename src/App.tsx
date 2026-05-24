import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiPickOverlay, type AiPickEvent } from "./components/AiPickOverlay";
import { BrainScene, type AnatomyLoadProgress } from "./components/BrainScene";
import { InfoPanel } from "./components/InfoPanel";
import { LogicalRegionIndicator } from "./components/LogicalRegionIndicator";
import { PipelineOverlay } from "./components/PipelineOverlay";
import { DigitalTwinPanel } from "./components/DigitalTwinPanel";
import { RegionControls } from "./components/RegionControls";
import { UnifiedPanel } from "./components/UnifiedPanel";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { StatusBar } from "./components/StatusBar";
import { VisionCortexPanel } from "./components/vision/VisionCortexPanel";
import { CognitivePanel } from "./components/cognition/CognitivePanel";
import { CompactLayout, FocusMode, CommandPalette, useCommandPalette } from "./components/brain-os";
import { REGION_DEFINITIONS, BRAIN_ACTIONS } from "./data/regionDefinitions";
import {
  DEFAULT_AUTO_TIER,
  DEFAULT_PRESET,
  PERF_PRESETS,
  nextMode,
  type PerfMode,
  type PerfPresetId,
} from "./engine/performancePresets";
import { useAutoQuality } from "./engine/useAutoQuality";
import { useLayoutMode, type LayoutMode } from "./engine/useLayoutMode";
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
const [selectedActionId, setSelectedActionId] = useState<BrainActionId>("attentional-blink");
const [showEmergentControls, setShowEmergentControls] = useState(true);
  
  // Phase 2 Panel States
  const [digitalTwinCollapsed, setDigitalTwinCollapsed] = useState(true);
  const [unifiedTab, setUnifiedTab] = useState<"ask" | "search" | "memory" | "graph" | "cortex" | "swarm" | "imagine" | "evolve" | "organism">("ask");
  const [unifiedCollapsed, setUnifiedCollapsed] = useState(false);

  const [shellTransparent, setShellTransparent] = useState(true);
  const [signalSpeed, setSignalSpeed] = useState(1.3);
  const [perfMode, setPerfMode] = useState<PerfMode>(DEFAULT_PRESET);
  const [autoTier, setAutoTier] = useState<PerfPresetId>(DEFAULT_AUTO_TIER);
  const [fps, setFps] = useState(60);
  // Full-mode density slider sets a manual override; null = follow the preset.
  const [densityOverride, setDensityOverride] = useState<number | null>(null);
  // In Auto mode the adaptive controller drives the effective tier; otherwise
  // the user's fixed choice is used directly.
  const effectivePresetId: PerfPresetId = perfMode === "auto" ? autoTier : perfMode;
  const preset = PERF_PRESETS[effectivePresetId];
  const neuronDensity = densityOverride ?? preset.density;
  useAutoQuality(perfMode === "auto", setAutoTier, setFps);
  const { mode: layout, setMode, cycle: cycleLayout } = useLayoutMode();
  const { isOpen: commandPaletteOpen, setIsOpen: setCommandPaletteOpen } = useCommandPalette(layout, perfMode);

  const openUnifiedTab = useCallback((tab: typeof unifiedTab) => {
    setMode("full");
    setUnifiedCollapsed(false);
    setUnifiedTab(tab);
  }, [setMode]);

  const toggleDigitalTwin = useCallback((collapsed?: boolean) => {
    setMode("full");
    setDigitalTwinCollapsed((c) => (collapsed !== undefined ? collapsed : !c));
  }, [setMode]);

  const toggleUnifiedPanel = useCallback((collapsed?: boolean) => {
    setMode("full");
    setUnifiedCollapsed((c) => (collapsed !== undefined ? collapsed : !c));
  }, [setMode]);

  const cyclePreset = useCallback(() => {
    setPerfMode((m) => nextMode(m));
    setDensityOverride(null);
  }, []);
  const [regionVisibility, setRegionVisibility] = useState<RegionVisibility>(DEFAULT_VISIBILITY);
  const [selectedRegionId, setSelectedRegionId] = useState<BrainRegionId | null>("motor-l");
  const [anatomyVisible, setAnatomyVisible] = useState(true);
  const [anatomyOpacity, setAnatomyOpacity] = useState(0.32);
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
    // Focus Mode toggle: F11 or Ctrl+Shift+F
    if (event.key === "F11" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "F")) {
      event.preventDefault();
      if (layout === "focus") {
        setMode("compact");
      } else {
        setMode("focus");
      }
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
      case "p":
      case "P":
        cyclePreset();
        break;
      case "l":
      case "L":
        cycleLayout();
        break;
      case "e":
      case "E":
        setShowEmergentControls((e) => !e);
        break;
    }
  };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const anatomyPercent = useMemo(() => {
    if (anatomyProgress.done) {
      return 100;
    }
    if (anatomyProgress.total > 0) {
      return Math.min(99, Math.round((anatomyProgress.loaded / anatomyProgress.total) * 100));
    }
    return null;
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
    <main className="app-shell" data-layout={layout}>
      {/* Hybrid-cognition HUD. Self-gates: renders only when a HybridCognitiveCore
          is active (i.e. the app was opened with ?useHybrid=true), in any layout. */}
      <CognitivePanel />
      {layout === "compact" && (
        <CompactLayout
          running={running}
          selectedActionId={selectedActionId}
          shellTransparent={shellTransparent}
          signalSpeed={signalSpeed}
          neuronDensity={neuronDensity}
          anatomyVisible={anatomyVisible}
          anatomyOpacity={anatomyOpacity}
          audioEnabled={false}
          regionVisibility={sceneVisibility}
          selectedRegionId={selectedRegionId}
          onRunningChange={setRunning}
          onActionChange={setSelectedActionId}
          onShellTransparentChange={setShellTransparent}
          onSignalSpeedChange={setSignalSpeed}
          onNeuronDensityChange={setDensityOverride}
          onAnatomyVisibleChange={setAnatomyVisible}
          onAnatomyOpacityChange={setAnatomyOpacity}
          onAudioEnabledChange={() => {}}
          onRegionSelect={setSelectedRegionId}
          onRegionVisibilityChange={handleRegionVisibilityChange}
          onCameraPreset={handleCameraPreset}
          shellOpacity={shellOpacity}
          perfPreset={preset}
          perfMode={perfMode}
          effectiveTier={effectivePresetId}
          aiPick={aiPick}
          onAnatomyLoadProgress={setAnatomyProgress}
          onMetricsChange={setMetrics}
          cameraPreset={cameraPreset}
          metrics={{ ...metrics, fps }}
          currentLayout={layout}
          onLayoutChange={setMode}
          onCycleLayout={cycleLayout}
          onCyclePreset={cyclePreset}
        />
      )}

      {layout === "focus" && (
        <FocusMode
          running={running}
          selectedActionId={selectedActionId}
          shellTransparent={shellTransparent}
          signalSpeed={signalSpeed}
          neuronDensity={neuronDensity}
          anatomyVisible={anatomyVisible}
          anatomyOpacity={anatomyOpacity}
          audioEnabled={false}
          regionVisibility={sceneVisibility}
          selectedRegionId={selectedRegionId}
          shellOpacity={shellOpacity}
          perfPreset={preset}
          aiPick={aiPick}
          onAnatomyLoadProgress={setAnatomyProgress}
          onMetricsChange={setMetrics}
          cameraPreset={cameraPreset}
          onRegionSelect={setSelectedRegionId}
          onExitFocus={() => setMode("compact")}
          metrics={{ ...metrics, fps }}
        />
      )}

      {layout === "full" && (
        <>
      <BrainScene
        aiPick={aiPick}
        anatomyOpacity={anatomyOpacity}
        anatomyVisible={anatomyVisible}
        audioEnabled={false}
        cameraPreset={cameraPreset}
        neuronDensity={neuronDensity}
        onAnatomyLoadProgress={setAnatomyProgress}
        onMetricsChange={setMetrics}
        onRegionSelect={setSelectedRegionId}
        onActionSelect={setSelectedActionId}
        perfPreset={preset}
        regionVisibility={sceneVisibility}
        selectedActionId={selectedActionId}
        selectedRegionId={selectedRegionId}
        showEmergentControls={showEmergentControls}
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
            audioEnabled={false}
            neuronDensity={neuronDensity}
            onActionChange={setSelectedActionId}
            onAnatomyOpacityChange={setAnatomyOpacity}
            onAnatomyVisibleChange={setAnatomyVisible}
            onAudioEnabledChange={() => {}}
            onCameraPreset={handleCameraPreset}
            onNeuronDensityChange={setDensityOverride}
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
          <DigitalTwinPanel
            collapsed={digitalTwinCollapsed}
            onCollapsedChange={setDigitalTwinCollapsed}
          />
          <UnifiedPanel
            tab={unifiedTab}
            onTabChange={setUnifiedTab}
            collapsed={unifiedCollapsed}
            onCollapsedChange={setUnifiedCollapsed}
          />
          <VisionCortexPanel />
          <StatusBar
            mode={perfMode}
            effectiveTier={effectivePresetId}
            onCyclePreset={cyclePreset}
            layout={layout}
            onCycleLayout={cycleLayout}
          />
        </>
      )}

      <ShortcutsModal />
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        currentLayout={layout}
        currentPerfMode={perfMode}
        onLayoutChange={setMode}
        onCyclePreset={cyclePreset}
        onFocusMode={() => setMode("focus")}
        onCompactMode={() => setMode("compact")}
        onFullMode={() => setMode("full")}
        onToggleDigitalTwin={toggleDigitalTwin}
        onOpenUnifiedTab={openUnifiedTab}
        onToggleUnifiedPanel={toggleUnifiedPanel}
      />
    </main>
  );
}

export default App;
