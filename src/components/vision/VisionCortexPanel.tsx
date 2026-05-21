import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Eye, EyeOff, Image, Settings, Trash2, X } from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../../engine/brainBus";
import type {
  ScreenCapture,
  VisualMemory,
  UIState,
} from "../../../shared/vision";

interface VisionCaptureResult {
  capture: ScreenCapture;
  memory: VisualMemory;
  regions: DetectedRegion[];
  uiState: UIState;
}

interface DetectedRegion {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  confidence: number;
  app?: string;
}

interface VisionStats {
  total: number;
  byApp: Record<string, number>;
  recentCount: number;
  oldestTimestamp: number | null;
}

const STORAGE_KEY_VISION_ENABLED = "brain-vision-enabled";

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function VisionCortexPanel(): JSX.Element | null {
  const [enabled, setEnabled] = useState(() => {
    return localStorage.getItem(STORAGE_KEY_VISION_ENABLED) === "true";
  });
  const [collapsed, setCollapsed] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCapture, setLastCapture] = useState<VisualMemory | null>(null);
  const [recentMemories, setRecentMemories] = useState<VisualMemory[]>([]);
  const [currentRegions, setCurrentRegions] = useState<DetectedRegion[]>([]);
  const [currentUIState, setCurrentUIState] = useState<UIState | null>(null);
  const [stats, setStats] = useState<VisionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    return subscribeConnection((ok) => {
      if (!ok || seeded.current || !enabled) return;
      seeded.current = true;
      void fetchVisionData();
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const unsub = subscribeBrainBus((message) => {
      switch (message.type) {
        case "screen-captured":
          break;
        case "visual-memory-created":
          setLastCapture(message.memory);
          setRecentMemories((prev) => [message.memory, ...prev.slice(0, 19)]);
          break;
        case "visual-regions-detected":
          setCurrentRegions(
            message.regions.map((r) => ({
              type: r.regionType,
              x: r.boundingBox.x,
              y: r.boundingBox.y,
              width: r.boundingBox.width,
              height: r.boundingBox.height,
              label: r.detectedText ?? "",
              confidence: r.confidence,
              app: r.detectedApp ?? undefined,
            }))
          );
          break;
        case "ui-state-detected":
          setCurrentUIState(message.state);
          break;
        case "vision-error":
          setError(message.error);
          setTimeout(() => setError(null), 5000);
          break;
      }
    });

    return unsub;
  }, [enabled]);

  const fetchVisionData = async () => {
    try {
      const baseUrl = (import.meta as { env?: Record<string, string | undefined> }).env
        ?.VITE_BRAIN_API_URL ?? "http://127.0.0.1:8787";

      const [memoriesRes, statsRes] = await Promise.all([
        fetch(`${baseUrl}/api/vision/memories?limit=20`),
        fetch(`${baseUrl}/api/vision/stats`),
      ]);

      if (memoriesRes.ok) {
        const data = await memoriesRes.json();
        setRecentMemories(data.results?.map((r: { memory: VisualMemory }) => r.memory) ?? []);
      }

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
    } catch {
    }
  };

  const handleCapture = useCallback(async () => {
    if (isCapturing) return;

    setIsCapturing(true);
    setError(null);

    try {
      const baseUrl = (import.meta as { env?: Record<string, string | undefined> }).env
        ?.VITE_BRAIN_API_URL ?? "http://127.0.0.1:8787";

      const res = await fetch(`${baseUrl}/api/vision/capture`, {
        method: "GET",
        headers: { "X-Brain-Local": "1" },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const data: VisionCaptureResult = await res.json();
      setLastCapture(data.memory);
      setCurrentRegions(data.regions);
      if (data.uiState) {
        setCurrentUIState(data.uiState as UIState);
      }
      setRecentMemories((prev) => [data.memory, ...prev.slice(0, 19)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing]);

  const handleToggleEnabled = useCallback(() => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    localStorage.setItem(STORAGE_KEY_VISION_ENABLED, String(newEnabled));

    if (newEnabled) {
      seeded.current = false;
    }
  }, [enabled]);

  const handleDeleteMemory = useCallback(async (id: string) => {
    try {
      const baseUrl = (import.meta as { env?: Record<string, string | undefined> }).env
        ?.VITE_BRAIN_API_URL ?? "http://127.0.0.1:8787";

      await fetch(`${baseUrl}/api/vision/memories/${id}`, {
        method: "DELETE",
        headers: { "X-Brain-Local": "1" },
      });

      setRecentMemories((prev) => prev.filter((m) => m.id !== id));
      if (lastCapture?.id === id) {
        setLastCapture(null);
      }
    } catch {
    }
  }, [lastCapture]);

  if (!enabled && collapsed) {
    return (
      <div className="vision-trigger" style={{ position: "fixed", top: 60, right: 16, zIndex: 100 }}>
        <button
          onClick={handleToggleEnabled}
          className="vision-enable-btn"
          title="Enable Vision Cortex"
          style={{
            background: "rgba(20, 20, 30, 0.9)",
            border: "1px solid rgba(100, 100, 255, 0.3)",
            borderRadius: 8,
            padding: "8px 12px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "rgba(150, 150, 255, 0.8)",
            fontSize: 12,
          }}
        >
          <Eye size={14} />
          Vision
        </button>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div
        className="vision-panel-collapsed"
        style={{
          position: "fixed",
          top: 60,
          right: 16,
          zIndex: 100,
          background: "rgba(15, 15, 25, 0.95)",
          border: "1px solid rgba(100, 100, 255, 0.3)",
          borderRadius: 12,
          padding: 12,
          minWidth: 200,
          maxWidth: 320,
          fontFamily: "monospace",
          fontSize: 12,
          color: "rgba(200, 200, 255, 0.9)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Eye size={14} style={{ color: "rgba(100, 150, 255, 0.9)" }} />
            <span style={{ fontWeight: "bold", fontSize: 13 }}>Vision Cortex</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleCapture}
              disabled={isCapturing}
              title="Capture screen"
              style={{
                background: isCapturing ? "rgba(100, 100, 255, 0.3)" : "rgba(80, 80, 200, 0.5)",
                border: "1px solid rgba(100, 100, 255, 0.5)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: isCapturing ? "not-allowed" : "pointer",
                color: "rgba(200, 200, 255, 0.9)",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Camera size={12} />
              {isCapturing ? "..." : ""}
            </button>
            <button
              onClick={() => setCollapsed(false)}
              title="Expand"
              style={{
                background: "transparent",
                border: "1px solid rgba(100, 100, 255, 0.3)",
                borderRadius: 4,
                padding: "4px 6px",
                cursor: "pointer",
                color: "rgba(150, 150, 255, 0.8)",
              }}
            >
              <Settings size={12} />
            </button>
            <button
              onClick={handleToggleEnabled}
              title="Disable Vision"
              style={{
                background: "transparent",
                border: "1px solid rgba(100, 100, 255, 0.3)",
                borderRadius: 4,
                padding: "4px 6px",
                cursor: "pointer",
                color: "rgba(150, 150, 255, 0.8)",
              }}
            >
              <EyeOff size={12} />
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              background: "rgba(255, 60, 60, 0.15)",
              border: "1px solid rgba(255, 60, 60, 0.4)",
              borderRadius: 4,
              padding: "6px 8px",
              marginBottom: 8,
              fontSize: 11,
              color: "rgba(255, 150, 150, 0.9)",
            }}
          >
            {error}
          </div>
        )}

        {lastCapture && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: "rgba(150, 150, 255, 0.6)", marginBottom: 4 }}>
              LAST CAPTURE
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span>{lastCapture.sourceApp ?? "Unknown"}</span>
              <span style={{ color: "rgba(150, 150, 255, 0.6)" }}>
                {formatTimestamp(lastCapture.captureTimestamp)}
              </span>
            </div>
            {lastCapture.windowTitle && (
              <div
                style={{
                  fontSize: 10,
                  color: "rgba(150, 150, 255, 0.5)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {lastCapture.windowTitle}
              </div>
            )}
          </div>
        )}

        {stats && stats.total > 0 && (
          <div style={{ fontSize: 10, color: "rgba(150, 150, 255, 0.6)" }}>
            {stats.total} captures stored
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="vision-panel"
      style={{
        position: "fixed",
        top: 60,
        right: 16,
        zIndex: 100,
        background: "rgba(10, 10, 20, 0.97)",
        border: "1px solid rgba(80, 80, 200, 0.4)",
        borderRadius: 12,
        padding: 16,
        width: 360,
        maxHeight: "calc(100vh - 120px)",
        overflow: "auto",
        fontFamily: "monospace",
        fontSize: 12,
        color: "rgba(200, 200, 255, 0.9)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
          borderBottom: "1px solid rgba(80, 80, 200, 0.3)",
          paddingBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Eye size={16} style={{ color: "rgba(100, 150, 255, 0.9)" }} />
          <span style={{ fontWeight: "bold", fontSize: 14 }}>Vision Cortex</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={handleCapture}
            disabled={isCapturing}
            title="Capture screen"
            style={{
              background: isCapturing ? "rgba(80, 80, 200, 0.4)" : "rgba(60, 60, 180, 0.6)",
              border: "1px solid rgba(100, 100, 255, 0.5)",
              borderRadius: 6,
              padding: "6px 12px",
              cursor: isCapturing ? "not-allowed" : "pointer",
              color: "rgba(200, 200, 255, 0.9)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
            }}
          >
            <Camera size={13} />
            {isCapturing ? "Capturing..." : "Capture"}
          </button>
          <button
            onClick={handleToggleEnabled}
            title="Disable Vision"
            style={{
              background: "rgba(255, 60, 60, 0.15)",
              border: "1px solid rgba(255, 80, 80, 0.4)",
              borderRadius: 6,
              padding: "6px 8px",
              cursor: "pointer",
              color: "rgba(255, 150, 150, 0.9)",
            }}
          >
            <EyeOff size={13} />
          </button>
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse"
            style={{
              background: "transparent",
              border: "1px solid rgba(80, 80, 200, 0.3)",
              borderRadius: 6,
              padding: "6px 8px",
              cursor: "pointer",
              color: "rgba(150, 150, 255, 0.8)",
            }}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "rgba(255, 60, 60, 0.12)",
            border: "1px solid rgba(255, 60, 60, 0.35)",
            borderRadius: 6,
            padding: "8px 10px",
            marginBottom: 12,
            fontSize: 11,
            color: "rgba(255, 150, 150, 0.95)",
          }}
        >
          {error}
        </div>
      )}

      {currentUIState && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 10,
              color: "rgba(120, 120, 200, 0.7)",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            UI State
          </div>
          <div
            style={{
              background: "rgba(60, 60, 120, 0.2)",
              border: "1px solid rgba(80, 80, 180, 0.3)",
              borderRadius: 6,
              padding: "8px 10px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  background:
                    currentUIState.type === "coding"
                      ? "rgba(80, 180, 80, 0.3)"
                      : currentUIState.type === "build_error" || currentUIState.type === "test_failure"
                      ? "rgba(255, 80, 80, 0.3)"
                      : "rgba(80, 80, 200, 0.3)",
                  borderRadius: 4,
                  padding: "2px 8px",
                  fontSize: 11,
                  fontWeight: "bold",
                }}
              >
                {currentUIState.type.replace(/_/g, " ")}
              </span>
              <span style={{ fontSize: 10, color: "rgba(150, 150, 255, 0.6)" }}>
                {Math.round(currentUIState.confidence * 100)}% confident
              </span>
            </div>
            {currentUIState.detail && (
              <div style={{ fontSize: 11, marginTop: 4, color: "rgba(180, 180, 255, 0.7)" }}>
                {currentUIState.detail}
              </div>
            )}
            {currentRegions.length > 0 && (
              <div style={{ fontSize: 10, marginTop: 6, color: "rgba(120, 120, 200, 0.6)" }}>
                {currentRegions.length} regions detected
              </div>
            )}
          </div>
        </div>
      )}

      {stats && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 10,
              color: "rgba(120, 120, 200, 0.7)",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Statistics
          </div>
          <div
            style={{
              background: "rgba(40, 40, 80, 0.2)",
              border: "1px solid rgba(60, 60, 140, 0.25)",
              borderRadius: 6,
              padding: "8px 10px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <div>
              <div style={{ fontSize: 18, fontWeight: "bold", color: "rgba(150, 150, 255, 0.9)" }}>
                {stats.total}
              </div>
              <div style={{ fontSize: 10, color: "rgba(120, 120, 200, 0.6)" }}>total captures</div>
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: "bold", color: "rgba(150, 150, 255, 0.9)" }}>
                {Object.keys(stats.byApp).length}
              </div>
              <div style={{ fontSize: 10, color: "rgba(120, 120, 200, 0.6)" }}>applications</div>
            </div>
          </div>
        </div>
      )}

      {recentMemories.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 10,
              color: "rgba(120, 120, 200, 0.7)",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Recent Captures
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {recentMemories.slice(0, 10).map((memory) => (
              <div
                key={memory.id}
                style={{
                  background: "rgba(40, 40, 80, 0.15)",
                  border: "1px solid rgba(60, 60, 140, 0.2)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <Image size={14} style={{ color: "rgba(100, 100, 200, 0.6)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      marginBottom: 2,
                    }}
                  >
                    <span style={{ fontWeight: "bold", color: "rgba(180, 180, 255, 0.9)" }}>
                      {memory.sourceApp ?? "Unknown"}
                    </span>
                    <span style={{ color: "rgba(120, 120, 200, 0.6)", fontSize: 10 }}>
                      {formatTimestamp(memory.captureTimestamp)}
                    </span>
                  </div>
                  {memory.windowTitle && (
                    <div
                      style={{
                        fontSize: 10,
                        color: "rgba(140, 140, 220, 0.6)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {memory.windowTitle}
                    </div>
                  )}
                  <div style={{ fontSize: 9, color: "rgba(100, 100, 180, 0.5)", marginTop: 2 }}>
                    {memory.width}×{memory.height}
                  </div>
                </div>
                <button
                  onClick={() => void handleDeleteMemory(memory.id)}
                  title="Delete capture"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 4,
                    cursor: "pointer",
                    color: "rgba(180, 80, 80, 0.5)",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {recentMemories.length === 0 && !isCapturing && (
        <div
          style={{
            textAlign: "center",
            padding: "24px 16px",
            color: "rgba(120, 120, 200, 0.5)",
            fontSize: 12,
          }}
        >
          <Camera size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
          <div>No captures yet</div>
          <div style={{ fontSize: 10, marginTop: 4 }}>Click "Capture" to take a screenshot</div>
        </div>
      )}
    </div>
  );
}