// Digital Twin dashboard — a collapsible overlay (full layout only, alongside
// PipelineOverlay/UnifiedPanel). Live system map driven by /ws/brain
// `twin-snapshot` / `twin-anomaly` messages, seeded by GET /api/twin.
//
// Gate-safety (see DIGITAL_TWIN_SPEC.md §7):
//  * Renders `null` until a snapshot exists. test:all runs Vite WITHOUT the
//    server, so the bus never connects, the seed fetch never fires, and this
//    component renders nothing — it cannot perturb verify:canvas / smoke.
//  * The seed fetch is gated on bus connectivity, so a failed :8787 HTTP
//    request (which would log a console error smoke-actions counts) never
//    happens when the backend is down.
//  * No <input type=range> (smoke grabs the last range slider as the density
//    control). No <button> text colliding with an action label / "L Memory".
//  * Private `.twin-*` CSS namespace; never throws; no console output.

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Database,
  HardDrive,
} from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../engine/brainBus";
import { apiClient } from "../engine/apiClient";
import type { TwinView, TwinAnomaly } from "../../shared/twin";

const ANOMALY_CAP = 20;

function gb(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function pct(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function Bar({ value }: { value: number | null }): JSX.Element {
  if (value === null) return <span className="twin-dash">—</span>;
  return (
    <span className="twin-bar" aria-hidden="true">
      <span className="twin-bar-fill" style={{ width: `${value}%` }} />
    </span>
  );
}

const SEV_CLASS: Record<TwinAnomaly["severity"], string> = {
  info: "twin-sev-info",
  warn: "twin-sev-warn",
  critical: "twin-sev-crit",
};

interface DigitalTwinPanelProps {
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function DigitalTwinPanel({
  collapsed: controlledCollapsed,
  onCollapsedChange,
}: DigitalTwinPanelProps = {}): JSX.Element | null {
  const [view, setView] = useState<TwinView | null>(null);
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const seeded = useRef(false);

  const collapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;
  const setCollapsed = (c: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof c === "function" ? c(collapsed) : c;
    if (onCollapsedChange) {
      onCollapsedChange(next);
    } else {
      setInternalCollapsed(next);
    }
  };

  // Seed only once the bus is connected — proves the backend is up, so the
  // HTTP fetch won't fail-and-log when the server is absent.
  useEffect(() => {
    return subscribeConnection((ok) => {
      if (!ok || seeded.current) return;
      seeded.current = true;
      apiClient
        .twin()
        .then(setView)
        .catch(() => {
          seeded.current = false; // allow a retry on the next reconnect
        });
    });
  }, []);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type === "twin-snapshot") {
        setView((prev) => ({
          snapshot: message.snapshot,
          anomalies: prev?.anomalies ?? [],
          predictions: prev?.predictions ?? [],
        }));
      } else if (message.type === "twin-anomaly") {
        setView((prev) => ({
          snapshot: prev?.snapshot ?? null,
          anomalies: [message.anomaly, ...(prev?.anomalies ?? [])].slice(
            0,
            ANOMALY_CAP,
          ),
          predictions: prev?.predictions ?? [],
        }));
      }
    });
  }, []);

  if (!view || !view.snapshot) return null;

  const s = view.snapshot;
  const hw = s.hardware;
  const memPct = pct(hw.memUsedBytes, hw.memTotalBytes);
  const diskPct = pct(hw.diskUsedBytes, hw.diskTotalBytes);
  const healthPct = Math.round(s.healthScore * 100);

  return (
    <aside className="twin-panel" aria-label="Digital Twin">
      <header className="twin-head">
        <Activity size={14} />
        <span>Digital Twin</span>
        <small className={`twin-health twin-health-${healthScoreTier(s.healthScore)}`}>
          health {healthPct}%
        </small>
        <button
          type="button"
          className="twin-toggle"
          aria-label={collapsed ? "Expand Digital Twin" : "Collapse Digital Twin"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="twin-body">
          <section className="twin-section">
            <h4>
              <Cpu size={12} /> Hardware
            </h4>
            <ul className="twin-rows">
              <li>
                <span>CPU</span>
                <Bar value={hw.cpuPct} />
                <em>{hw.cpuPct}%</em>
              </li>
              <li>
                <span>Memory</span>
                <Bar value={memPct} />
                <em>
                  {gb(hw.memUsedBytes)} / {gb(hw.memTotalBytes)}
                </em>
              </li>
              <li>
                <span>Disk</span>
                <Bar value={diskPct} />
                <em>
                  {hw.diskTotalBytes === null
                    ? "—"
                    : `${gb(hw.diskUsedBytes)} / ${gb(hw.diskTotalBytes)}`}
                </em>
              </li>
              <li>
                <span>Load / Temp / Batt</span>
                <em className="twin-muted">
                  {hw.loadAvg1 === null ? "—" : hw.loadAvg1.toFixed(2)} ·{" "}
                  {hw.cpuTempC === null ? "—" : `${hw.cpuTempC}°C`} ·{" "}
                  {hw.batteryPct === null ? "—" : `${hw.batteryPct}%`}
                </em>
              </li>
              <li className="twin-meta">
                <span>{hw.cores} cores</span>
                <em className="twin-muted">{hw.cpuModel}</em>
              </li>
            </ul>
          </section>

          <section className="twin-section">
            <h4>
              <Database size={12} /> Software · AI
            </h4>
            <p className="twin-muted twin-small">
              {s.software.platform} {s.software.arch} · node{" "}
              {s.software.nodeVersion}
            </p>
            <div className="twin-chips">
              {s.software.connectors.length === 0 ? (
                <span className="twin-chip twin-muted">no connectors</span>
              ) : (
                s.software.connectors.map((c) => (
                  <span
                    key={c.id}
                    className={`twin-chip twin-conn-${c.state}`}
                    title={`${c.kind} (${c.state})`}
                  >
                    {c.kind}
                    {c.isDefault ? " ★" : ""}
                  </span>
                ))
              )}
            </div>
          </section>

          <section className="twin-section">
            <h4>
              <Activity size={12} /> Workflow · Cognitive
            </h4>
            <ul className="twin-rows">
              <li>
                <span>Active runs</span>
                <em>{s.workflow.activeRuns}</em>
              </li>
              <li>
                <span>Recurring patterns</span>
                <em>{s.workflow.recurringPatterns}</em>
              </li>
              <li>
                <span>Focus</span>
                <Bar value={s.cognitive.focus * 100} />
                <em>{Math.round(s.cognitive.focus * 100)}%</em>
              </li>
              <li>
                <span>Memory access / hr</span>
                <em>{s.cognitive.recentMemoryAccess}</em>
              </li>
            </ul>
          </section>

          {view.predictions.length > 0 && (
            <section className="twin-section">
              <h4>Predicted (+15 min)</h4>
              <ul className="twin-rows">
                {view.predictions.map((p) => (
                  <li key={p.metric}>
                    <span>{p.metric}</span>
                    <em title={p.reason}>
                      {p.predicted} ·{" "}
                      <span className="twin-muted">
                        {Math.round(p.confidence * 100)}% conf
                      </span>
                    </em>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {s.project.projects.length > 0 && (
            <section className="twin-section">
              <h4>Projects</h4>
              <ul className="twin-rows">
                {s.project.projects.slice(0, 5).map((p) => (
                  <li key={p.name}>
                    <span>{p.name}</span>
                    <em className="twin-muted">
                      {p.fileCount} files · {p.languages.slice(0, 3).join(" ")}
                    </em>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="twin-section">
            <h4>
              <AlertTriangle size={12} /> Anomalies
            </h4>
            {view.anomalies.length === 0 ? (
              <p className="twin-muted twin-small">none detected</p>
            ) : (
              <ul className="twin-anomalies">
                {view.anomalies.slice(0, 8).map((a) => (
                  <li key={a.id} className={SEV_CLASS[a.severity]}>
                    <strong>{a.kind}</strong>
                    <span>{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}

function healthScoreTier(score: number): "good" | "warn" | "bad" {
  if (score >= 0.6) return "good";
  if (score >= 0.35) return "warn";
  return "bad";
}
