import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, Loader2, Network, Play, RefreshCw } from "lucide-react";
import { apiClient, ApiError } from "../engine/apiClient";
import { brainApiBaseUrl } from "../engine/apiClient";
import { isBrainBusConnected, subscribeConnection } from "../engine/brainBus";
import { subscribeBrainBus } from "../engine/brainBus";
import { LocalityBadge } from "./LocalityBadge";

interface HealthState {
  db: "ok" | "error" | "unknown";
  vector: "ok" | "unavailable" | "unknown";
  memoryCount: number;
  connectors: Array<{
    id: string;
    kind: string;
    state: string;
    enabled: boolean;
    isDefault?: boolean;
    isLocal: boolean;
    baseUrl?: string;
  }>;
  locality: "local" | "remote" | "unknown";
}

interface ScanLiveState {
  running: boolean;
  processed: number;
  total: number;
  current?: string;
}

const INITIAL: HealthState = {
  db: "unknown",
  vector: "unknown",
  memoryCount: 0,
  connectors: [],
  locality: "unknown",
};

export function SystemStatusPanel(): JSX.Element {
  const [health, setHealth] = useState<HealthState>(INITIAL);
  const [scan, setScan] = useState<ScanLiveState>({ running: false, processed: 0, total: 0 });
  const [wsConnected, setWsConnected] = useState(isBrainBusConnected());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiClient.health();
      setHealth({
        db: data.db,
        vector: data.vector,
        memoryCount: data.memoryCount,
        connectors: data.connectors,
        locality: data.locality,
      });
      const scanRes = await apiClient.scanState();
      setScan({
        running: scanRes.state.running,
        processed: scanRes.state.processed,
        total: scanRes.state.total,
        current: scanRes.state.current ?? undefined,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        setError("Server unreachable — start it with `npm run dev:server`.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setHealth(INITIAL);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => subscribeConnection(setWsConnected), []);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type === "scan") {
        setScan({
          running: !message.done,
          processed: message.processed,
          total: message.total,
          current: message.current,
        });
      }
    });
  }, []);

  const triggerScan = useCallback(async () => {
    try {
      await apiClient.triggerScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const remoteUrls = useMemo(
    () =>
      health.connectors
        .filter((c) => c.enabled && !c.isLocal && c.baseUrl)
        .map((c) => c.baseUrl as string),
    [health.connectors],
  );

  return (
    <div className="brain-os-section">
      <header className="status-row">
        <span className={`status-dot ${health.db === "ok" ? "live" : "offline"}`} />
        <span>API: <strong>{health.db === "ok" ? "online" : "offline"}</strong></span>
        <span className="status-divider">·</span>
        <span className={`status-dot ${wsConnected ? "live" : "offline"}`} />
        <span>Brain bus: <strong>{wsConnected ? "live" : "disconnected"}</strong></span>
        <button
          className="ai-icon-button"
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh"
          style={{ marginLeft: "auto" }}
        >
          {busy ? <Loader2 size={14} className="ai-spin" /> : <RefreshCw size={14} />}
        </button>
      </header>
      <LocalityBadge locality={health.locality} remoteUrls={remoteUrls} />
      <small className="status-detail" title={brainApiBaseUrl()}>
        Server: {brainApiBaseUrl()}
      </small>
      {error ? <p className="ai-error">{error}</p> : null}
      <ul className="status-grid">
        <li>
          <Database size={14} />
          <span>SQLite</span>
          <strong className={health.db === "ok" ? "live" : "offline"}>{health.db}</strong>
        </li>
        <li>
          <Network size={14} />
          <span>Vector store</span>
          <strong className={health.vector === "ok" ? "live" : "offline"}>{health.vector}</strong>
        </li>
        <li>
          <span style={{ width: 14 }} />
          <span>Memories</span>
          <strong>{health.memoryCount.toLocaleString()}</strong>
        </li>
      </ul>
      <div className="status-connectors">
        <small>Connectors</small>
        {health.connectors.length === 0 ? (
          <p className="ai-hint">None registered.</p>
        ) : (
          <ul>
            {health.connectors.map((c) => (
              <li key={c.id}>
                <span className={`status-dot ${c.state === "ok" ? "live" : "offline"}`} />
                <span>{c.id}</span>
                <small>{c.kind}</small>
                <small className="status-state">{c.state}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="scan-row">
        <button className="ai-send" type="button" onClick={() => void triggerScan()} disabled={scan.running}>
          <Play size={14} /> {scan.running ? "Scanning…" : "Run scan"}
        </button>
        <div className="scan-progress">
          <div
            className="scan-progress-bar"
            style={{
              width: scan.total > 0 ? `${Math.min(100, (scan.processed / Math.max(1, scan.total)) * 100)}%` : "0%",
            }}
          />
        </div>
        <small>
          {scan.processed}/{scan.total}
          {scan.current ? ` · ${trimPath(scan.current)}` : ""}
        </small>
      </div>
    </div>
  );
}

function trimPath(p: string): string {
  if (p.length <= 38) {
    return p;
  }
  return `…${p.slice(p.length - 36)}`;
}
