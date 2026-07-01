import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { AiPickOverlay, type AiPickEvent } from "./components/AiPickOverlay";
import { BrainScene, type AnatomyLoadProgress, type BrainSceneApi } from "./components/BrainScene";
import { SettingsPanel } from "./components/SettingsPanel";
import { ToastHost } from "./components/ToastHost";
import { TrainingBar } from "./components/TrainingBar";
import { OnboardingHints } from "./components/OnboardingHints";
import { InfoPanel } from "./components/InfoPanel";
import { LogicalRegionIndicator } from "./components/LogicalRegionIndicator";
import { PipelineOverlay } from "./components/PipelineOverlay";
import { DigitalTwinPanel } from "./components/DigitalTwinPanel";
import { PerceptionPanel } from "./components/PerceptionPanel";
import { LearningLabPanel } from "./components/LearningLabPanel";
import { BrainStatePanel } from "./components/BrainStatePanel";
import { MemoryInspectorPanel } from "./components/MemoryInspectorPanel";
import { SelfConsciousnessPanel } from "./components/SelfConsciousnessPanel";
import { CognitionStreamPanel } from "./components/cognition/CognitionStreamPanel";
import { SpinePanel } from "./components/SpinePanel";
import { DeepResearchPanel } from "./components/research/DeepResearchPanel";
import { IdleThoughtTicker } from "./components/IdleThoughtTicker";
import { RegionControls } from "./components/RegionControls";
import { UnifiedPanel } from "./components/UnifiedPanel";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { StatusBar } from "./components/StatusBar";
import { VisionCortexPanel } from "./components/vision/VisionCortexPanel";
import { BrainLegendHUD } from "./components/cognition/BrainLegendHUD";
import { CognitivePanel } from "./components/cognition/CognitivePanel";
import { CompactLayout, FocusMode, CommandPalette, useCommandPalette } from "./components/brain-os";
import { ModelHubPanel } from "./components/ModelHubPanel";
import { DashboardLayout } from "./components/dashboard/DashboardLayout";
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
import { useClipboardCollector } from "./engine/useClipboardCollector";
import { useLayoutMode } from "./engine/useLayoutMode";
import { useLocalStorage } from "./engine/useApiCall";
import { actionForKey } from "./engine/keymap";
import { toastError, toastSuccess } from "./engine/toastBus";
import type {
  BrainActionId,
  BrainMetrics,
  BrainRegionId,
  CameraBookmark,
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
// User-facing config persists across reloads (useLocalStorage), so the app
// reopens exactly how it was left. Transient state (running, selection,
// metrics, camera) stays plain useState.
const [storedActionId, setSelectedActionId] = useLocalStorage<BrainActionId>("brain-action", "attentional-blink");
// Guard against a stale persisted id after the action list changes.
const selectedActionId: BrainActionId = BRAIN_ACTIONS.some((a) => a.id === storedActionId)
  ? storedActionId
  : "attentional-blink";
const [showEmergentControls, setShowEmergentControls] = useLocalStorage<boolean>("brain-emergent-controls", true);

  // Phase 2 Panel States
  // Phase 4 (improvement plan §11): UnifiedPanel defaults to collapsed so the
  // 3D scene is the centerpiece on first load. The user opens panels they need
  // via the CommandPalette / tab icons; the previous default buried the scene.
  const [digitalTwinCollapsed, setDigitalTwinCollapsed] = useLocalStorage<boolean>("brain-twin-collapsed", true);
  const [cognitionCollapsed, setCognitionCollapsed] = useLocalStorage<boolean>("brain-cognition-collapsed", true);
  const [spineCollapsed, setSpineCollapsed] = useLocalStorage<boolean>("brain-spine-collapsed", true);
  const [deepResearchCollapsed, setDeepResearchCollapsed] = useLocalStorage<boolean>("brain-dresearch-collapsed", true);
  const [unifiedTab, setUnifiedTab] = useLocalStorage<"ask" | "search" | "memory" | "graph" | "cortex" | "swarm" | "imagine" | "evolve" | "organism">("brain-unified-tab", "ask");
  const [unifiedCollapsed, setUnifiedCollapsed] = useLocalStorage<boolean>("brain-unified-collapsed", true);
  const [modelHubOpen, setModelHubOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [shellTransparent, setShellTransparent] = useLocalStorage<boolean>("brain-shell-transparent", true);
  const [signalSpeed, setSignalSpeed] = useLocalStorage<number>("brain-signal-speed", 1.3);
  const [storedPerfMode, setPerfMode] = useLocalStorage<PerfMode>("brain-perf-mode", DEFAULT_PRESET);
  const perfMode: PerfMode =
    storedPerfMode === "auto" || PERF_PRESETS[storedPerfMode as PerfPresetId] !== undefined
      ? storedPerfMode
      : DEFAULT_PRESET;
  const [autoTier, setAutoTier] = useState<PerfPresetId>(DEFAULT_AUTO_TIER);
  const [fps, setFps] = useState(60);
  // Full-mode density slider sets a manual override; null = follow the preset.
  const [densityOverride, setDensityOverride] = useLocalStorage<number | null>("brain-density-override", null);
  // In Auto mode the adaptive controller drives the effective tier; otherwise
  // the user's fixed choice is used directly.
  const effectivePresetId: PerfPresetId = perfMode === "auto" ? autoTier : perfMode;
  const preset = PERF_PRESETS[effectivePresetId];
  const neuronDensity = densityOverride ?? preset.density;
  useAutoQuality(perfMode === "auto", setAutoTier, setFps);
  // Phase 2b — ambient clipboard ingestion. Self-gates: no-op outside Tauri and
  // unless the user has consented to the "clipboard" source.
  useClipboardCollector();
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

  const toggleCognitionStream = useCallback((collapsed?: boolean) => {
    setMode("full");
    setCognitionCollapsed((c) => (collapsed !== undefined ? collapsed : !c));
  }, [setMode]);

  const toggleSpine = useCallback((collapsed?: boolean) => {
    setMode("full");
    setSpineCollapsed((c) => (collapsed !== undefined ? collapsed : !c));
  }, [setMode]);

  const toggleDeepResearch = useCallback((collapsed?: boolean) => {
    setMode("full");
    setDeepResearchCollapsed((c) => (collapsed !== undefined ? collapsed : !c));
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
  const [anatomyVisible, setAnatomyVisible] = useLocalStorage<boolean>("brain-anatomy-visible", true);
  const [anatomyOpacity, setAnatomyOpacity] = useLocalStorage<number>("brain-anatomy-opacity", 0.32);
  const [metrics, setMetrics] = useState<BrainMetrics>({
    neurons: 0,
    pathways: 0,
    regions: REGION_DEFINITIONS.length,
  });
  const [cameraPreset, setCameraPreset] = useState<CameraPresetRequest>({
    mode: "overview",
    sequence: 0,
  });
const [aiPick] = useState<AiPickEvent | null>(null);
const [anatomyProgress, setAnatomyProgress] = useState<AnatomyLoadProgress>({
  loaded: 0,
  total: 0,
  done: false,
});

  // Imperative scene surface (camera bookmarks + screenshot). Bound by the
  // full-layout BrainScene; other layouts leave it null and the handlers
  // degrade with a toast.
  const sceneApiRef = useRef<BrainSceneApi | null>(null);
  const [cameraBookmarks, setCameraBookmarks] = useLocalStorage<CameraBookmark[]>("brain-camera-bookmarks", []);

  const handleScreenshot = useCallback(() => {
    const dataUrl = sceneApiRef.current?.screenshot() ?? null;
    if (!dataUrl) {
      toastError("Screenshot needs the Full layout's 3D scene");
      return;
    }
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `brain-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
    link.click();
    toastSuccess("Screenshot saved");
  }, []);

  const handleSaveBookmark = useCallback(() => {
    const state = sceneApiRef.current?.getCameraState() ?? null;
    if (!state) {
      toastError("Camera unavailable");
      return;
    }
    if (cameraBookmarks.length >= 6) {
      toastError("Up to 6 saved views — delete one first");
      return;
    }
    const maxN = cameraBookmarks.reduce((max, b) => {
      const m = /^View (\d+)$/.exec(b.name);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    const name = `View ${maxN + 1}`;
    setCameraBookmarks([
      ...cameraBookmarks,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, ...state },
    ]);
    toastSuccess(`Saved "${name}"`);
  }, [cameraBookmarks, setCameraBookmarks]);

  const handleGoBookmark = useCallback(
    (id: string) => {
      const bookmark = cameraBookmarks.find((b) => b.id === id);
      if (bookmark) sceneApiRef.current?.flyTo(bookmark);
    },
    [cameraBookmarks],
  );

  const handleDeleteBookmark = useCallback(
    (id: string) => {
      setCameraBookmarks((list) => list.filter((b) => b.id !== id));
    },
    [setCameraBookmarks],
  );

  const shellOpacity = shellTransparent ? 0.02 : 0.08;

useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    // Focus Mode toggle: F11 or Ctrl+Shift+F (fixed chord)
    if (event.key === "F11" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "F")) {
      event.preventDefault();
      if (layout === "focus") {
        setMode("compact");
      } else {
        setMode("focus");
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // Fixed keys.
    if (event.key === " ") {
      event.preventDefault();
      setRunning((r) => !r);
      return;
    }
    if (event.key >= "1" && event.key <= "7") {
      const index = parseInt(event.key, 10) - 1;
      if (index < BRAIN_ACTIONS.length) {
        setSelectedActionId(BRAIN_ACTIONS[index].id);
      }
      return;
    }
    // Rebindable keys (Settings → Shortcuts). While the settings modal is
    // open, only its own openSettings toggle stays live so stray presses
    // don't move the camera behind the dialog.
    const action = actionForKey(event.key);
    if (!action) return;
    if (settingsOpen && action !== "openSettings") return;
    switch (action) {
      case "overview":
        setCameraPreset((p) => ({ mode: "overview", sequence: p.sequence + 1 }));
        break;
      case "inside":
        setCameraPreset((p) => ({ mode: "inside", sequence: p.sequence + 1 }));
        break;
      case "resetCamera":
        setCameraPreset((p) => ({ mode: "reset", sequence: p.sequence + 1 }));
        break;
      case "toggleShell":
        setShellTransparent((t) => !t);
        break;
      case "toggleAnatomy":
        setAnatomyVisible((v) => !v);
        break;
      case "cyclePreset":
        cyclePreset();
        break;
      case "cycleLayout":
        cycleLayout();
        break;
      case "toggleEmergent":
        setShowEmergentControls((e) => !e);
        break;
      case "screenshot":
        handleScreenshot();
        break;
      case "openSettings":
        setSettingsOpen((o) => !o);
        break;
    }
  };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    layout,
    setMode,
    settingsOpen,
    cyclePreset,
    cycleLayout,
    handleScreenshot,
    setSelectedActionId,
    setShellTransparent,
    setAnatomyVisible,
    setShowEmergentControls,
  ]);

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
      <BrainLegendHUD />
      {/* Always-visible Settings entry point. The "full" layout already has a gear
          in its StatusBar; compact / focus / dashboard have no other button, so
          this floating gear is their only on-screen way in (hidden in full via CSS
          to avoid a duplicate). The "," key and Ctrl+K palette still work too. */}
      <button
        type="button"
        className="global-settings-fab"
        onClick={() => setSettingsOpen(true)}
        title="Settings — ,"
        aria-label="Open settings"
      >
        <Settings2 size={18} />
      </button>
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
        sceneApiRef={sceneApiRef}
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
            cameraBookmarks={cameraBookmarks}
            onSaveBookmark={handleSaveBookmark}
            onGoBookmark={handleGoBookmark}
            onDeleteBookmark={handleDeleteBookmark}
            onScreenshot={handleScreenshot}
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
          <PerceptionPanel />
          <LearningLabPanel />
          <BrainStatePanel />
          <MemoryInspectorPanel />
          <SelfConsciousnessPanel />
          <CognitionStreamPanel
            collapsed={cognitionCollapsed}
            onCollapsedChange={setCognitionCollapsed}
          />
          <SpinePanel collapsed={spineCollapsed} onCollapsedChange={setSpineCollapsed} />
          <DeepResearchPanel collapsed={deepResearchCollapsed} onCollapsedChange={setDeepResearchCollapsed} />
          <IdleThoughtTicker />
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
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </>
      )}

      {layout === "dashboard" && (
        <DashboardLayout
          running={running}
          selectedActionId={selectedActionId}
          selectedRegionId={selectedRegionId}
          regionVisibility={regionVisibility}
          metrics={{ ...metrics, fps }}
          onRegionSelect={setSelectedRegionId}
          onActionSelect={setSelectedActionId}
          onMetricsChange={setMetrics}
        />
      )}

      <ShortcutsModal />
      <ModelHubPanel open={modelHubOpen} onClose={() => setModelHubOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ToastHost />
      <TrainingBar />
      <OnboardingHints />
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
        onToggleCognitionStream={toggleCognitionStream}
        onToggleSpine={toggleSpine}
        onToggleDeepResearch={toggleDeepResearch}
        onOpenUnifiedTab={openUnifiedTab}
        onToggleUnifiedPanel={toggleUnifiedPanel}
        onOpenModelHub={() => setModelHubOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onScreenshot={handleScreenshot}
      />
    </main>
  );
}

export default App;
