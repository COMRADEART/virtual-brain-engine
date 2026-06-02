import { useEffect, useState } from "react";

// Mirrors the Rust `SystemMetrics` returned by the `get_system_metrics` Tauri
// command (src-tauri/src/system_monitor.rs). serde serializes with the default
// snake_case field names, so the nested shape is reproduced verbatim here.
// Only the fields this widget renders are typed; the command also returns
// `disk`, `processes`, `load_average`, and `uptime`.
export interface SystemMetrics {
  timestamp: number;
  cpu: { overall: number; per_core: number[]; cpu_count: number };
  memory: { total: number; used: number; available: number; usage_percent: number };
  network: { received: number; transmitted: number; rx_rate: number; tx_rate: number };
}

// Tauri v2 dropped window.__TAURI__; the canonical detection is the
// __TAURI_INTERNALS__ injection (see src/engine/apiClient.ts). Live telemetry
// is only available inside the desktop shell — on the plain web build the
// command doesn't exist, so we render a degraded state instead of hanging.
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

const GB = 1024 * 1024 * 1024;

export function SystemMonitorWidget() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = inTauri();

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const fetchMetrics = async () => {
      try {
        // Lazy import so the @tauri-apps/api dependency only loads under the
        // desktop shell — matches the convention in src/engine/apiClient.ts and
        // keeps it out of the web bundle.
        const { invoke } = await import("@tauri-apps/api/core");
        const data = await invoke<SystemMetrics>("get_system_metrics");
        if (!active) return;
        setMetrics(data);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [desktop]);

  // Web build: the system bridge isn't reachable. Say so plainly rather than
  // spinning on "Syncing Telemetry…" forever.
  if (!desktop) {
    return (
      <div className="dashboard-widget system-widget offline">
        <header className="widget-header">
          <h3 className="widget-title">System Real-Time</h3>
          <span className="live-indicator offline">WEB</span>
        </header>
        <div className="widget-body">
          <p className="widget-note">
            Live system telemetry is available in the desktop app. Launch via{" "}
            <code>npm run tauri:dev</code> to monitor CPU, memory, and network.
          </p>
        </div>
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="dashboard-widget system-widget offline">
        <header className="widget-header">
          <h3 className="widget-title">System Real-Time</h3>
          <span className="live-indicator offline">ERR</span>
        </header>
        <div className="widget-body">
          <p className="widget-note">Telemetry bridge unavailable: {error}</p>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="dashboard-widget system-widget loading">
        <div className="widget-loading-pulse" />
        <span>Syncing Telemetry...</span>
      </div>
    );
  }

  const cpuPercent = Math.min(100, Math.max(0, metrics.cpu.overall));
  const memPercent = Math.min(100, Math.max(0, metrics.memory.usage_percent));

  return (
    <div className="dashboard-widget system-widget">
      <header className="widget-header">
        <h3 className="widget-title">System Real-Time</h3>
        <span className="live-indicator">LIVE</span>
      </header>
      <div className="widget-body">
        <div className="metric-row">
          <div className="metric-info">
            <span className="metric-label">CPU CORE LOAD</span>
            <span className="metric-value">{cpuPercent.toFixed(1)}%</span>
          </div>
          <div className="metric-bar-container">
            <div className="metric-bar" style={{ width: `${cpuPercent}%`, background: "var(--cyan)" }} />
          </div>
        </div>

        <div className="metric-row">
          <div className="metric-info">
            <span className="metric-label">MEMORY ALLOC</span>
            <span className="metric-value">{(metrics.memory.used / GB).toFixed(1)}GB</span>
          </div>
          <div className="metric-bar-container">
            <div className="metric-bar" style={{ width: `${memPercent}%`, background: "var(--green)" }} />
          </div>
        </div>

        <div className="network-stats">
          <div className="net-stat">
            <small>RX DATA</small>
            <span>{(metrics.network.rx_rate / 1024).toFixed(1)} KB/s</span>
          </div>
          <div className="net-stat">
            <small>TX DATA</small>
            <span>{(metrics.network.tx_rate / 1024).toFixed(1)} KB/s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
