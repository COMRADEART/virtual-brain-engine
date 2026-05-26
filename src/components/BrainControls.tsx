import { useEffect, useState, useRef } from "react";
import type {
  BrainActionId,
  BrainRegionId,
  BrainSimulation,
  NeuralGraph,
  SignalPulse,
} from "../engine/types";
import { ACTION_BY_ID } from "../engine/brainRegions";
import type { LogicalRegionId } from "../../shared/pipeline";
import { LOGICAL_REGION_MAP } from "../engine/logicalRegions";
import { apiClient } from "../engine/apiClient";

interface BrainControlsProps {
  simulation: BrainSimulation | null;
  graph: NeuralGraph | null;
  regionIntensity: Float32Array | null;
  regionOrder: BrainRegionId[] | null;
  currentActionId: BrainActionId | null;
  onActionChange: (actionId: BrainActionId) => void;
  onNeuromodulatorChange: (name: string, value: number) => void;
  onOscillationChange: (type: 'theta' | 'gamma', value: number) => void;
  onMemorySearch: (query: string) => void;
  onMemoryPlayback: (memoryId: string) => void;
  isRecording: boolean;
  onToggleRecording: () => void;
  isPlaying: boolean;
  onTogglePlayback: () => void;
  fps: number;
  neuronCount: number;
}

export const BrainControls: React.FC<BrainControlsProps> = ({
  simulation,
  graph,
  regionIntensity,
  regionOrder,
  currentActionId,
  onActionChange,
  onNeuromodulatorChange,
  onOscillationChange,
  onMemorySearch,
  onMemoryPlayback,
  isRecording,
  onToggleRecording,
  isPlaying,
  onTogglePlayback,
  fps,
  neuronCount,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [memories, setMemories] = useState<Array<{id: string; content: string; timestamp: number}>>([]);
  const toggleRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Toggle panel visibility
  const togglePanel = () => setIsOpen(!isOpen);

  // Close panel when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Format intensity for display (0-1 to percentage)
  const formatIntensity = (value: number) => `${Math.round(value * 100)}%`;

  // Get region name from ID
  const getRegionName = (regionId: BrainRegionId): string => {
    // This would ideally come from regionDefinitions, but we'll use a simple mapping
    const regionMap: Record<string, string> = {
      "frontal-l": "Frontal L (Left)",
      "frontal-r": "Frontal R (Right)",
      "parietal-l": "Parietal L (Left)",
      "parietal-r": "Parietal R (Right)",
      "temporal-l": "Temporal L (Left)",
      "temporal-r": "Temporal R (Right)",
      "occipital-l": "Occipital L (Left)",
      "occipital-r": "Occipital R (Right)",
      "cingulate-l": "Cingulate L (Left)",
      "cingulate-r": "Cingulate R (Right)",
      "insular-l": "Insular L (Left)",
      "insular-r": "Insular R (Right)",
      "hippocampus-l": "Hippocampus L (Left)",
      "hippocampus-r": "Hippocampus R (Right)",
      "amygdala-l": "Amygdala L (Left)",
      "amygdala-r": "Amygdala R (Right)",
      "basal-ganglia-l": "Basal Ganglia L (Left)",
      "basal-ganglia-r": "Basal Ganglia R (Right)",
      "thalamus-l": "Thalamus L (Left)",
      "thalamus-r": "Thalamus R (Right)",
      "hypothalamus": "Hypothalamus",
      "cerebellum-l": "Cerebellum L (Left)",
      "cerebellum-r": "Cerebellum R (Right)",
      "brainstem": "Brainstem",
    };
    return regionMap[regionId] || regionId;
  };

  // Get dominant rhythm based on simulation
  const getDominantRhythm = () => {
    if (!simulation) return "Unknown";

    // For SignalSimulation, these are stubs; for SpikingEngine, they're real
    const thetaPhase = simulation.thetaPhase || 0;
    const gammaPhase = simulation.gammaPhase || 0;

    // Simple dominance: whichever has higher value (normalized)
    const thetaNorm = Math.abs(Math.sin(thetaPhase));
    const gammaNorm = Math.abs(Math.sin(gammaPhase * 2)); // Gamma is faster

    return thetaNorm > gammaNorm ? "Theta" : "Gamma";
  };

  // Get neuromodulator levels (with fallbacks for SignalSimulation)
  const getNeuromodulators = () => {
    if (!simulation) return { dopamine: 0, acetylcholine: 0 };

    // SignalSimulation has these as fixed values
    const dopamine = typeof simulation.dopamine === 'number' ? simulation.dopamine : 0.3;
    const acetylcholine = typeof simulation.acetylcholine === 'number' ? simulation.acetylcholine : 0.4;

    return { dopamine, acetylcholine };
  };

  // Handle memory search
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onMemorySearch(searchQuery);
  };

  // Load real recent memories from the backend memory store. The visualizer
  // also runs standalone (no server), so failures degrade to the empty state
  // rather than throwing — the "No memories found" branch handles it.
  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const { memories: points } = await apiClient.recentMemories(12);
        if (ignore) return;
        setMemories(
          points.map((m) => ({
            id: m.id,
            content: m.content,
            timestamp: Date.parse(m.updatedAt || m.createdAt) || Date.now(),
          })),
        );
      } catch {
        if (!ignore) setMemories([]);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="brain-controls-container" onClick={togglePanel} ref={toggleRef}>
      <div className={`brain-controls-panel ${isOpen ? 'open' : 'closed'}`} ref={panelRef}>
        <div className="brain-controls-header">
          <h2>🧠 VIRTUAL BRAIN CONTROLS</h2>
          <button className="close-button" onClick={togglePanel}>×</button>
        </div>

        <div className="brain-controls-tabs">
          <div className="tab-pane active" id="dashboard">
            {/* Real-time Brain State */}
            <div className="brain-state-section">
              <h3>Brain State Monitor</h3>
              <div className="state-grid">
                <div className="state-item">
                  <label>Dominant Rhythm</label>
                  <div className="state-value">{getDominantRhythm()}</div>
                </div>
                <div className="state-item">
                  <label>Overall Activity</label>
                  <div className="state-value">
                    {regionIntensity ?
                      `${formatIntensity(regionIntensity.reduce((a, b) => a + b, 0) / regionIntensity.length)}`
                      : "0%"}
                  </div>
                </div>
                <div className="state-item">
                  <label>FPS</label>
                  <div className="state-value">{fps.toFixed(1)}</div>
                </div>
                <div className="state-item">
                  <label>Neurons</label>
                  <div className="state-value">{neuronCount}</div>
                </div>
              </div>
            </div>

            {/* Neuromodulator Levels */}
            <div className="neuromod-section">
              <h3>Neuromodulators</h3>
              <div className="modulator-grid">
                {Object.entries(getNeuromodulators()).map(([name, value]) => (
                  <div className="modulator-item" key={name}>
                    <label>{name.toUpperCase()}</label>
                    <div className="modulator-bar">
                      <div
                        className="modulator-fill"
                        style={{ width: `${value * 100}%` }}
                      ></div>
                    </div>
                    <div className="modulator-value">{formatIntensity(value)}</div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={value}
                      onChange={(e) => onNeuromodulatorChange(name, parseFloat(e.target.value))}
                      disabled={!(simulation && typeof (simulation as unknown as Record<string, unknown>)[name] === 'number')}
                      title="Adjust level"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Oscillation Intensity */}
            <div className="oscillation-section">
              <h3>Neural Oscillations</h3>
              <div className="oscillator-grid">
                <div className="oscillator-item">
                  <label>THETA (4-8 Hz)</label>
                  <div className="oscillator-display">
                    <div className="wave" style={{
                      height: `${40 + Math.sin(Date.now() / 200) * 10}px`,
                      background: `linear-gradient(90deg, var(--neon-blue), var(--neon-pink))`
                    }}></div>
                  </div>
                  <div className="oscillator-controls">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={simulation?.thetaPhase || 0}
                      onChange={(e) => onOscillationChange('theta', parseFloat(e.target.value))}
                    />
                  </div>
                </div>
                <div className="oscillator-item">
                  <label>GAMMA (30-100 Hz)</label>
                  <div className="oscillator-display">
                    <div className="wave" style={{
                      height: `${20 + Math.sin(Date.now() / 50) * 5}px`,
                      background: `linear-gradient(90deg, var(--neon-pink), var(--neon-green))`
                    }}></div>
                  </div>
                  <div className="oscillator-controls">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={simulation?.gammaPhase || 0}
                      onChange={(e) => onOscillationChange('gamma', parseFloat(e.target.value))}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="tab-pane" id="regions">
            {/* Brain Regions Activation */}
            <div className="regions-section">
              <h3>Regional Activation</h3>
              {regionOrder && regionIntensity ? (
                <div className="region-list">
                  {regionOrder.map((regionId, index) => {
                    const intensity = regionIntensity[index] ?? 0;
                    return (
                      <div className="region-item" key={regionId}>
                        <div className="region-info">
                          <span className="region-name">{getRegionName(regionId)}</span>
                          <span className="region-intensity">{formatIntensity(intensity)}</span>
                        </div>
                        <div className="region-bar">
                          <div
                            className="region-fill"
                            style={{
                              width: `${intensity * 100}%`,
                              background: `linear-gradient(90deg, var(--neon-blue), var(--neon-pink))`
                            }}
                          ></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="loading">Loading region data...</p>
              )}
            </div>
          </div>

          <div className="tab-pane" id="actions">
            {/* Brain Action Buttons */}
            <div className="actions-section">
              <h3>Brain Actions</h3>
              <div className="action-grid">
                {Object.entries(ACTION_BY_ID).map(([id, action]) => {
                  const isActive = id === currentActionId;
                  return (
                    <button
                      key={id}
                      className={`action-button ${isActive ? 'active' : ''}`}
                      onClick={() => onActionChange(id as BrainActionId)}
                    >
                      <div className="action-icon">{(action as { icon?: string }).icon || '⚡'}</div>
                      <div className="action-label">{action.label}</div>
                      <div className="action-description">{action.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="tab-pane" id="memory">
            {/* Memory Interface */}
            <div className="memory-section">
              <h3>Memory Recall</h3>
              <form className="memory-search-form" onSubmit={handleSearch}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search memories..."
                  className="memory-search-input"
                />
                <button type="submit" className="memory-search-button">🔍 Search</button>
              </form>

              <div className="memory-list">
                {memories.length > 0 ? (
                  memories.map((memory) => (
                    <div className="memory-item" key={memory.id}>
                      <div className="memory-content">{memory.content}</div>
                      <div className="memory-meta">
                        <span className="memory-time">{new Date(memory.timestamp).toLocaleTimeString()}</span>
                        <button
                          className="memory-play-button"
                          onClick={() => onMemoryPlayback(memory.id)}
                        >
                          ▶️ Play
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="no-memories">No memories found. Try searching or creating new experiences.</p>
                )}
              </div>
            </div>
          </div>

          <div className="tab-pane" id="recording">
            {/* Recording & Playback */}
            <div className="recording-section">
              <h3>Session Recording</h3>
              <div className="recording-controls">
                <button
                  className={`record-button ${isRecording ? 'recording' : ''}`}
                  onClick={onToggleRecording}
                >
                  {isRecording ? '■ Stop Recording' : '● Record Session'}
                </button>
                <button
                  className={`play-button ${isPlaying ? 'playing' : ''}`}
                  onClick={onTogglePlayback}
                >
                  {isPlaying ? '■ Stop Playback' : '▶️ Playback Session'}
                </button>
                <div className="recording-status">
                  {isRecording ? '● RECORDING' : isPlaying ? '▶️ PLAYING' : '⏸️ IDLE'}
                </div>
              </div>

              <div className="recording-info">
                <p>Record brain activity patterns for later analysis and playback.</p>
                <p>Useful for studying cognitive states and behavioral correlations.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="brain-controls-footer">
          <div className="tab-indicators">
            <button
              className={`${isOpen && true ? 'active' : ''}`}
              onClick={() => {/* Tab switching would be implemented here */}}
            >
              Dashboard
            </button>
            <button
              className={`${isOpen && true ? '' : 'active'}`}
              onClick={() => {/* Tab switching */}}
            >
              Regions
            </button>
            <button
              className={`${isOpen && true ? '' : 'active'}`}
              onClick={() => {/* Tab switching */}}
            >
              Actions
            </button>
            <button
              className={`${isOpen && true ? '' : 'active'}`}
              onClick={() => {/* Tab switching */}}
            >
              Memory
            </button>
            <button
              className={`${isOpen && true ? '' : 'active'}`}
              onClick={() => {/* Tab switching */}}
            >
              Recording
            </button>
          </div>
          <div className="version-tag">v2.1.4-CYBERPUNK</div>
        </div>
      </div>
    </div>
  );
};

// Cyberpunk CSS Styles
const style = document.createElement('style');
style.textContent = `
  :root {
    --bg-color: rgba(0, 0, 0, 0.6);
    --neon-blue: #00ffff;
    --neon-pink: #ff00ff;
    --neon-green: #00ff00;
    --neon-purple: #bf00ff;
    --text-color: #ffffff;
    --glass: rgba(255, 255, 255, 0.1);
    --glass-border: rgba(255, 255, 255, 0.2);
    --shadow-blue: 0 0 15px var(--neon-blue);
    --shadow-pink: 0 0 15px var(--neon-pink);
    --transition: all 0.3s ease;
  }

  .brain-controls-container {
    position: fixed;
    top: 20px;
    right: 20px;
    width: 60px;
    height: 60px;
    z-index: 1000;
    cursor: pointer;
    transition: var(--transition);
  }

  .brain-controls-container:hover {
    transform: scale(1.1);
  }

  .brain-controls-panel {
    position: fixed;
    top: 20px;
    right: 20px;
    width: 380px;
    max-height: 85vh;
    background: var(--glass);
    backdrop-filter: blur(20px);
    border: 1px solid var(--glass-border);
    border-radius: 16px;
    box-shadow:
      0 0 30px var(--neon-blue),
      inset 0 0 10px rgba(255, 255, 255, 0.1);
    overflow-y: auto;
    padding: 20px;
    opacity: 0;
    pointer-events: none;
    transform: translateX(30px);
    transition: var(--transition);
    z-index: 1001;
  }

  .brain-controls-panel.open {
    opacity: 1;
    pointer-events: all;
    transform: translateX(0);
  }

  .brain-controls-panel.closed {
    opacity: 0;
    pointer-events: none;
    transform: translateX(30px);
  }

  .brain-controls-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 25px;
    padding-bottom: 15px;
    border-bottom: 1px solid var(--glass-border);
  }

  .brain-controls-header h2 {
    color: var(--text-color);
    font-size: 1.5rem;
    font-weight: 600;
    text-shadow: 0 0 10px var(--neon-blue);
    letter-spacing: 1px;
    margin: 0;
  }

  .close-button {
    background: transparent;
    border: none;
    color: var(--text-color);
    font-size: 1.5rem;
    cursor: pointer;
    text-shadow: 0 0 5px var(--neon-pink);
    transition: var(--transition);
  }

  .close-button:hover {
    color: var(--neon-pink);
    text-shadow: 0 0 10px var(--neon-pink);
    transform: rotate(90deg);
  }

  .brain-controls-tabs {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .tab-pane {
    display: none;
    animation: fadeIn 0.3s ease;
  }

  .tab-pane.active {
    display: block;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Section Styles */
  .brain-state-section, .neuromod-section, .oscillation-section,
  .regions-section, .actions-section, .memory-section, .recording-section {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 12px;
    padding: 18px;
    margin-bottom: 20px;
    border: 1px solid rgba(0, 255, 255, 0.1);
    box-shadow: var(--shadow-blue);
  }

  .brain-state-section h3, .neuromod-section h3, .oscillation-section h3,
  .regions-section h3, .actions-section h3, .memory-section h3,
  .recording-section h3 {
    color: var(--neon-blue);
    font-size: 1.2rem;
    margin-top: 0;
    margin-bottom: 15px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .brain-state-section h3::before, .neuromod-section h3::before,
  .oscillation-section h3::before, .regions-section h3::before,
  .actions-section h3::before, .memory-section h3::before,
  .recording-section h3::before {
    content: "▸";
    color: var(--neon-pink);
    font-size: 0.8rem;
  }

  .state-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 15px;
  }

  .state-item {
    display: flex;
    flex-direction: column;
  }

  .state-item label {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 5px;
  }

  .state-value {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--text-color);
    text-shadow: 0 0 5px var(--neon-blue);
    background: rgba(0, 0, 0, 0.3);
    padding: 5px 10px;
    border-radius: 8px;
    border: 1px solid rgba(0, 255, 255, 0.2);
  }

  .modulator-grid, .oscillator-grid {
    display: grid;
    gap: 15px;
  }

  .modulator-item, .oscillator-item {
    display: flex;
    flex-direction: column;
  }

  .modulator-item label, .oscillator-item label {
    font-size: 0.9rem;
    color: var(--text-color);
    margin-bottom: 8px;
  }

  .modulator-bar, .oscillator-display {
    height: 12px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 8px;
    border: 1px solid rgba(0, 255, 255, 0.2);
  }

  .modulator-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--neon-blue), var(--neon-pink));
    transition: width 0.3s ease;
  }

  .modulator-value, .oscillator-value {
    font-size: 0.9rem;
    color: var(--neon-green);
    text-align: right;
    min-width: 40px;
  }

  .modulator-item input[type="range"],
  .oscillator-item input[type="range"] {
    width: 100%;
    height: 6px;
    background: transparent;
    border: none;
    outline: none;
    -webkit-appearance: none;
  }

  .modulator-item input[type="range"]::-webkit-slider-thumb,
  .oscillator-item input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--neon-pink);
    box-shadow: 0 0 8px var(--neon-pink);
    cursor: pointer;
  }

  .region-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .region-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 10px;
    border: 1px solid rgba(0, 255, 255, 0.15);
    transition: var(--transition);
  }

  .region-item:hover {
    background: rgba(0, 255, 255, 0.1);
    transform: translateX(5px);
    box-shadow: 0 0 15px var(--neon-blue);
  }

  .region-info {
    display: flex;
    justify-content: space-between;
    width: 100%;
  }

  .region-name {
    font-weight: 500;
    color: var(--text-color);
  }

  .region-intensity {
    font-size: 0.9rem;
    color: var(--neon-green);
    font-weight: 600;
  }

  .region-bar {
    flex-shrink: 0;
    width: 120px;
    height: 8px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 4px;
    overflow: hidden;
  }

  .action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 15px;
  }

  .action-button {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 255, 255, 0.2);
    border-radius: 12px;
    padding: 15px;
    text-align: center;
    cursor: pointer;
    transition: var(--transition);
    color: var(--text-color);
  }

  .action-button:hover {
    background: rgba(0, 255, 255, 0.1);
    transform: translateY(-3px);
    box-shadow: 0 0 20px var(--neon-blue);
    border-color: var(--neon-blue);
  }

  .action-button.active {
    background: rgba(0, 255, 255, 0.2);
    box-shadow: 0 0 25px var(--neon-blue);
    border-color: var(--neon-blue);
    animation: pulse 1.5s infinite;
  }

  @keyframes pulse {
    0% { box-shadow: 0 0 0 0px rgba(0, 255, 255, 0.4); }
    70% { box-shadow: 0 0 0 10px rgba(0, 255, 255, 0); }
    100% { box-shadow: 0 0 0 0px rgba(0, 255, 255, 0); }
  }

  .action-icon {
    font-size: 1.8rem;
    margin-bottom: 8px;
    text-shadow: 0 0 5px var(--neon-pink);
  }

  .action-label {
    font-weight: 600;
    margin-bottom: 5px;
    font-size: 1rem;
  }

  .action-description {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.3;
  }

  .memory-search-form {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
  }

  .memory-search-input {
    flex: 1;
    padding: 12px 15px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(0, 255, 255, 0.2);
    border-radius: 8px;
    color: var(--text-color);
    font-size: 0.95rem;
  }

  .memory-search-input::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }

  .memory-search-button {
    background: linear-gradient(45deg, var(--neon-blue), var(--neon-pink));
    border: none;
    border-radius: 8px;
    color: white;
    font-weight: 600;
    padding: 12px 20px;
    cursor: pointer;
    transition: var(--transition);
    text-shadow: 0 0 5px var(--neon-blue);
  }

  .memory-search-button:hover {
    transform: scale(1.05);
    box-shadow: 0 0 15px var(--neon-pink);
  }

  .memory-list {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .memory-item {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 10px;
    padding: 15px;
    border-left: 3px solid var(--neon-blue);
  }

  .memory-content {
    margin-bottom: 10px;
    line-height: 1.4;
    color: var(--text-color);
  }

  .memory-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
  }

  .memory-time {
    color: rgba(255, 255, 255, 0.6);
  }

  .memory-play-button {
    background: var(--neon-green);
    border: none;
    border-radius: 4px;
    color: white;
    padding: 4px 8px;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .memory-play-button:hover {
    background: var(--neon-green);
    box-shadow: 0 0 8px var(--neon-green);
    transform: scale(1.1);
  }

  .recording-controls {
    display: flex;
    gap: 15px;
    margin-bottom: 20px;
    justify-content: center;
  }

  .record-button, .play-button {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 255, 255, 0.2);
    border-radius: 50%;
    width: 50px;
    height: 50px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 1.2rem;
    transition: var(--transition);
    color: var(--text-color);
  }

  .record-button.recording {
    background: rgba(255, 0, 0, 0.4);
    box-shadow: 0 0 15px rgba(255, 0, 0, 0.6);
    animation: pulseRed 1s infinite;
  }

  @keyframes pulseRed {
    0% { box-shadow: 0 0 0 0px rgba(255, 0, 0, 0.4); }
    70% { box-shadow: 0 0 0 10px rgba(255, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0px rgba(255, 0, 0, 0); }
  }

  .play-button.playing {
    background: rgba(0, 255, 0, 0.4);
    box-shadow: 0 0 15px rgba(0, 255, 0, 0.6);
  }

  .recording-status {
    font-weight: 600;
    text-align: center;
    margin-bottom: 15px;
    font-size: 0.95rem;
  }

  .recording-info {
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.5;
  }

  .brain-controls-footer {
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid var(--glass-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: gap;
  }

  .tab-indicators {
    display: flex;
    gap: 10px;
  }

  .tab-indicators button {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(0, 255, 255, 0.15);
    border-radius: 20px;
    padding: 8px 15px;
    font-size: 0.85rem;
    color: var(--text-color);
    cursor: pointer;
    transition: var(--transition);
  }

  .tab-indicators button.active {
    background: var(--neon-blue);
    color: black;
    font-weight: 600;
    box-shadow: 0 0 10px var(--neon-blue);
  }

  .version-tag {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .no-memories, .loading {
    text-align: center;
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
    padding: 20px;
  }

  /* Scrollbar styling */
  .brain-controls-panel::-webkit-scrollbar {
    width: 8px;
  }

  .brain-controls-panel::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.1);
  }

  .brain-controls-panel::-webkit-scrollbar-thumb {
    background: linear-gradient(var(--neon-blue), var(--neon-pink));
    border-radius: 4px;
  }

  .brain-controls-panel::-webkit-scrollbar-thumb:hover {
    background: linear-gradient(var(--neon-pink), var(--neon-blue));
  }

  /* Responsive adjustments */
  @media (max-width: 768px) {
    .brain-controls-panel {
      width: 85vw;
      max-height: 80vh;
      top: 10px;
      right: 10px;
    }

    .brain-controls-container {
      width: 50px;
      height: 50px;
      top: 10px;
      right: 10px;
    }

    .state-grid {
      grid-template-columns: 1fr;
    }

    .tab-indicators {
      flex-wrap: wrap;
    }
  }
`;
document.head.appendChild(style);