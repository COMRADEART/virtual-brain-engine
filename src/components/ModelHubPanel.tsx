// Model Hub — "download a model → wire it into the brain". A centered modal
// (opened from the Command Palette) so it never collides with the corner panels.
// Pull progress streams over the bus (type "model-pull"), which ALSO flashes the
// model-hub cortex in the 3D scene; a slow poll backs it up. Selecting a model
// sets the CHAT model only (embeddings are fixed — see shared/models.ts).
//
// Gate-safety: renders null unless explicitly opened (so the smoke gates, which
// never open it, see nothing); no <input type=range>; button text ("pull"/"use")
// doesn't collide with action labels.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Cpu, Download, Globe, RefreshCw, X } from "lucide-react";
import { subscribeBrainBus } from "../engine/brainBus";
import { apiClient, type ModelUsageEntry } from "../engine/apiClient";
import type { ModelPullState, ModelsView } from "../../shared/models";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ModelHubPanel({ open, onClose }: Props): JSX.Element | null {
  const [view, setView] = useState<ModelsView | null>(null);
  const [pull, setPull] = useState<ModelPullState | null>(null);
  const [customName, setCustomName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [usage, setUsage] = useState<{ totalRuns: number; localRuns: number; remoteRuns: number; fallbackRuns: number; recentRuns: ModelUsageEntry[] } | null>(null);
  const [perfStats, setPerfStats] = useState<Awaited<ReturnType<typeof apiClient.getModelPerformanceStats>> | null>(null);
  const [routingInsights, setRoutingInsights] = useState<Awaited<ReturnType<typeof apiClient.getRoutingInsights>> | null>(null);
  const [perfDays, setPerfDays] = useState<number | undefined>(undefined);
  const [keyStats, setKeyStats] = useState<Awaited<ReturnType<typeof apiClient.getKeyStats>> | null>(null);
  const [calibration, setCalibration] = useState<Awaited<ReturnType<typeof apiClient.getConfidenceCalibration>> | null>(null);
  const [searchQuality, setSearchQuality] = useState<Awaited<ReturnType<typeof apiClient.getSearchQuality>> | null>(null);
  const [connectorHealth, setConnectorHealth] = useState<Awaited<ReturnType<typeof apiClient.getConnectorHealth>> | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [compareResults, setCompareResults] = useState<Awaited<ReturnType<typeof apiClient.compareModels>> | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback((): void => {
    apiClient
      .models()
      .then((v) => {
        setView(v);
        setPull(v.pull);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!open) return;
    setError(null);
    refresh();
    apiClient.getModelUsage().then(setUsage).catch(() => {});
    apiClient.getModelPerformanceStats(perfDays).then(setPerfStats).catch(() => {});
    apiClient.getRoutingInsights().then(setRoutingInsights).catch(() => {});
    apiClient.getKeyStats().then(setKeyStats).catch(() => {});
    apiClient.getConfidenceCalibration().then(setCalibration).catch(() => {});
    apiClient.getSearchQuality().then(setSearchQuality).catch(() => {});
    apiClient.getConnectorHealth().then(setConnectorHealth).catch(() => {});
  }, [open, refresh, perfDays]);

  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape key + focus trap
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll(FOCUSABLE);
        if (focusable.length === 0) return;
        const first = focusable[0] as HTMLElement;
        const last = focusable[focusable.length - 1] as HTMLElement;
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    };
    document.addEventListener("keydown", onKey);
    // Auto-focus the first focusable element
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Live progress over the bus (also flashes the model-hub cortex via BrainScene).
  useEffect(() => {
    if (!open) return;
    return subscribeBrainBus((m) => {
      if (m.type !== "model-pull") return;
      setPull((prev) => ({
        active: !m.done,
        model: m.model,
        status: m.status,
        percent: m.percent,
        done: m.done,
        error: null,
        startedAt: prev?.startedAt ?? new Date().toISOString(),
        finishedAt: m.done ? new Date().toISOString() : null,
      }));
      if (m.done) refreshRef.current(); // installed list + chat model changed
    });
  }, [open]);

  // Poll fallback while a pull is active (covers a tab that didn't initiate it).
  useEffect(() => {
    if (!open || !pull?.active) return;
    const id = window.setInterval(() => {
      apiClient.modelPullStatus().then(setPull).catch(() => {});
    }, 1500);
    return () => window.clearInterval(id);
  }, [open, pull?.active]);

  const doCompare = useCallback(async () => {
    if (compareModels.length < 2) return;
    try {
      const results = await apiClient.compareModels(compareModels);
      setCompareResults(results);
    } catch { /* ignore */ }
  }, [compareModels]);

  const doPull = useCallback((name: string): void => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    apiClient
      .pullModel(n)
      .then((r) => setPull(r.pull))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const doSelect = useCallback(
    (name: string): void => {
      setError(null);
      apiClient
        .selectModel(name)
        .then(() => refresh())
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [refresh],
  );

  const doSelectRemote = useCallback(
    (connectorId: string, model: string): void => {
      setError(null);
      apiClient
        .selectRemoteModel(connectorId, model)
        .then(() => refresh())
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [refresh],
  );

  const doRefreshRemote = useCallback((): void => {
    setRemoteLoading(true);
    apiClient
      .refreshRemoteModels()
      .then((r) => {
        setView((prev) => (prev ? { ...prev, remoteProviders: r.remoteProviders } : prev));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRemoteLoading(false));
  }, []);

  if (!open) return null;

  const pct = pull?.percent != null ? Math.round(pull.percent * 100) : null;
  const installed = new Set(view?.installed ?? []);
  const pulling = pull?.active === true;

  return (
    <div className="modelhub-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Model Hub">
      <div className="modelhub" onClick={(e) => e.stopPropagation()} ref={panelRef}>

        <h3>
          <Cpu size={16} /> Model Hub
          <button className="modelhub-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </h3>
        <p className="modelhub-sub">
          Download a local model or pick one from a remote provider (NVIDIA NIM, Gemini). Local downloads come from Ollama&apos;s registry; remote models run on the provider&apos;s servers.
        </p>

        {view && view.base === null ? (
          <p className="modelhub-err">No local Ollama daemon reachable. Start Ollama, then reopen.</p>
        ) : null}

        {view ? (
          <p className="modelhub-name">
            Chat model: <span className="modelhub-cur">{view.chatModel ?? "(none)"}</span>
          </p>
        ) : (
          <p className="modelhub-sub">Loading…</p>
        )}

        {view && !view.chatModel && view.suggested.length > 0 ? (
          <div className="modelhub-first-time">
            <strong>First time?</strong> Pull{" "}
            <code>{view.suggested[0].name}</code> below, then click{" "}
            <strong>use</strong> to set it as your chat model.
          </div>
        ) : null}

        {pull && (pull.active || pull.done || pull.error) ? (
          <div>
            <div className="modelhub-row" style={{ border: "none" }}>
              <span className="modelhub-name modelhub-grow">
                {pull.model} · {pull.status}
                {pull.error ? " ⚠" : ""}
              </span>
              <span className="modelhub-note">{pct != null ? `${pct}%` : pull.active ? "…" : ""}</span>
            </div>
            {pull.active || pct != null ? (
              <div className="modelhub-bar">
                <span style={{ width: `${pct ?? 8}%` }} />
              </div>
            ) : null}
            {pull.error ? <p className="modelhub-err" role="alert" aria-live="assertive">{pull.error}</p> : null}
          </div>
        ) : null}

        {view && view.base ? (
          <>
            <input
              className="modelhub-search"
              type="text"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value.toLowerCase())}
              placeholder="search models…"
            />
            <div className="modelhub-h4">Suggested chat models</div>
            {view.suggested
              .filter((s) => !modelFilter || s.name.toLowerCase().includes(modelFilter) || s.label.toLowerCase().includes(modelFilter))
              .map((s) => {
              const have = installed.has(s.name);
              return (
                <div className="modelhub-row" key={s.name}>
                  <span className="modelhub-grow">
                    <span className="modelhub-name">
                      {s.label} <span className="modelhub-note">{s.name}</span>
                    </span>
                    <br />
                    <span className="modelhub-note">{s.note}</span>
                  </span>
                  {have ? (
                    <button className="modelhub-btn" onClick={() => doSelect(s.name)}>
                      use
                    </button>
                  ) : (
                    <button className="modelhub-btn primary" disabled={pulling} onClick={() => doPull(s.name)}>
                      <Download size={11} /> pull
                    </button>
                  )}
                </div>
              );
            })}

            <div className="modelhub-h4">Pull by name</div>
            <div className="modelhub-row" style={{ border: "none" }}>
              <input
                className="modelhub-input"
                placeholder="e.g. mistral:7b"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doPull(customName);
                }}
              />
              <button className="modelhub-btn primary" disabled={pulling || !customName.trim()} onClick={() => doPull(customName)}>
                <Download size={11} /> pull
              </button>
            </div>

            {view.installed.length > 0 ? (
              <>
                <div className="modelhub-h4">Installed</div>
                {view.installed
                  .filter((name) => !modelFilter || name.toLowerCase().includes(modelFilter))
                  .map((name) => (
                  <div className="modelhub-row" key={name}>
                    <span className="modelhub-name modelhub-grow">
                      {name}
                      {name === view.chatModel ? <span className="modelhub-cur"> · in use</span> : null}
                    </span>
                    {name === view.chatModel ? (
                      <Check size={14} />
                    ) : (
                      <button className="modelhub-btn" onClick={() => doSelect(name)}>
                        use
                      </button>
                    )}
                  </div>
                ))}
              </>
            ) : null}
          </>
        ) : null}

        {view && view.remoteProviders && view.remoteProviders.length > 0 ? (
          <div className="modelhub-remote">
            <div className="modelhub-h4" style={{ marginTop: 0, display: "flex", alignItems: "center" }}>
              <Globe size={12} style={{ verticalAlign: -2 }} /> Remote providers
              <button
                className={`modelhub-refresh${remoteLoading ? " spinning" : ""}`}
                onClick={doRefreshRemote}
                disabled={remoteLoading}
                title="Refresh remote model lists"
                style={{ marginLeft: "auto" }}
              >
                <RefreshCw size={12} />
              </button>
            </div>
            {view.remoteProviders.map((rp) => (
              <div key={rp.id} style={{ marginBottom: 10 }}>
                <div className="modelhub-remote-header">
                  <span className="modelhub-name">{rp.name}</span>
                  <span className="modelhub-remote-tag">{rp.id}</span>
                  {rp.currentModel ? (
                    <span className="modelhub-note">active: {rp.currentModel}</span>
                  ) : null}
                </div>
                {rp.error ? (
                  <p className="modelhub-remote-err">{rp.error}</p>
                ) : rp.models.length === 0 ? (
                  <p className="modelhub-note" style={{ margin: 0 }}>No models returned.</p>
                ) : (
                  rp.models.map((m) => (
                    <div className="modelhub-row" key={m} style={{ padding: "3px 0" }}>
                      <span className={`modelhub-model-item modelhub-grow${m === rp.currentModel ? " active" : ""}`}>
                        {m}
                        {m === rp.currentModel ? " · in use" : ""}
                      </span>
                      {m === rp.currentModel ? (
                        <Check size={13} />
                      ) : (
                        <button className="modelhub-btn" onClick={() => doSelectRemote(rp.id, m)}>
                          use
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        ) : null}

        {usage && usage.totalRuns > 0 ? (
          <div className="modelhub-usage">
            <div className="modelhub-h4" style={{ marginTop: 0 }}>Recent runs</div>
            <div className="modelhub-usage-summary">
              <span>{usage.totalRuns} total</span>
              <span style={{ color: "var(--accent)" }}>{usage.localRuns} local</span>
              <span style={{ color: "var(--amber)" }}>{usage.remoteRuns} remote</span>
              {usage.fallbackRuns > 0 ? (
                <span style={{ color: "var(--red)" }}>{usage.fallbackRuns} fallback</span>
              ) : null}
            </div>
            <div className="modelhub-usage-list">
              {usage.recentRuns.slice(0, 10).map((r) => (
                <div className="modelhub-usage-row" key={r.id}>
                  <span className={`modelhub-usage-provider${r.provider === "remote" ? " remote" : ""}`}>
                    {r.provider === "remote" ? "☁" : "◉"}
                  </span>
                  <span className="modelhub-usage-model modelhub-grow">{r.model}</span>
                  <span className="modelhub-usage-latency">{r.latencyMs}ms</span>
                  {r.fallback ? <span className="modelhub-usage-fallback">fb</span> : null}
                  {r.error ? <span className="modelhub-usage-error">!</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {perfStats && perfStats.models.length > 0 ? (
          <div className="modelhub-usage">
            <div className="modelhub-perf-header">
              <div className="modelhub-h4" style={{ marginTop: 0 }}>Model Performance</div>
              <div className="modelhub-perf-filter">
                {([undefined, 1, 7, 30] as const).map((d) => (
                  <button
                    key={d ?? "all"}
                    onClick={() => setPerfDays(d)}
                    className={perfDays === d ? "active" : ""}
                  >
                    {d === undefined ? "All" : `${d}d`}
                  </button>
                ))}
              </div>
            </div>
            <div className="modelhub-usage-list">
              {perfStats.models.map((m) => (
                <div key={`${m.provider}-${m.model}`}>
                  <div className="modelhub-usage-row">
                    <span className={`modelhub-usage-provider${m.provider === "remote" ? " remote" : ""}`}>
                      {m.provider === "remote" ? "☁" : "◉"}
                    </span>
                    <span className="modelhub-usage-model modelhub-grow">{m.model}</span>
                    <span className="modelhub-usage-latency" title={`min ${m.minLatencyMs}ms / max ${m.maxLatencyMs}ms`}>
                      ~{Math.round(m.avgLatencyMs)}ms
                    </span>
                    <span style={{ color: m.errorRate > 0 ? "var(--red)" : "var(--accent)", fontSize: 10, marginLeft: 4 }}>
                      {m.runs} runs
                    </span>
                  </div>
                  {m.avgStepTimings && (
                    <div className="modelhub-step-timings">
                      {(["memory_ms", "reasoning_ms", "error_ms", "response_ms"] as const).map((k) => {
                        const ms = m.avgStepTimings[k];
                        if (!ms) return null;
                        const label = k.replace("_ms", "");
                        const threshold = k === "memory_ms" ? 2000 : k === "reasoning_ms" ? 5000 : k === "error_ms" ? 3000 : 10000;
                        const color = ms > threshold ? "var(--red)" : ms > threshold * 0.7 ? "var(--amber)" : "var(--accent)";
                        return (
                          <span key={k} style={{ color }} title={`${label}: ${ms}ms (threshold: ${threshold}ms)`}>
                            {label} {ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="modelhub-footer-note">
              p50 {Math.round(perfStats.overall.p50LatencyMs)}ms · p95 {Math.round(perfStats.overall.p95LatencyMs)}ms · {perfStats.overall.totalRuns} total
            </div>
          </div>
        ) : null}

        {perfStats && perfStats.models.length >= 2 ? (
          <div className="modelhub-usage">
            <div className="modelhub-h4" style={{ marginTop: 0 }}>Compare Models</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
              {perfStats.models.map((m) => {
                const selected = compareModels.includes(m.model);
                return (
                  <button
                    key={m.model}
                    className={`modelhub-compare-chip${selected ? " selected" : ""}`}
                    onClick={() => setCompareModels((prev) => selected ? prev.filter((x) => x !== m.model) : [...prev, m.model])}
                  >
                    {m.model}
                  </button>
                );
              })}
            </div>
            {compareModels.length >= 2 ? (
              <button className="modelhub-btn primary modelhub-compare-btn" onClick={doCompare}>
                Compare selected ({compareModels.length})
              </button>
            ) : null}
            {compareResults ? (
              <div className="modelhub-usage-list">
                {compareResults.map((r) => (
                  <div className="modelhub-usage-row" key={r.model}>
                    <span className="modelhub-usage-model modelhub-grow" style={{ fontSize: 11 }}>
                      {r.model}
                    </span>
                    <span className="modelhub-usage-latency" title="avg latency">
                      ~{r.avgLatencyMs}ms
                    </span>
                    <span className="modelhub-note" style={{ marginLeft: 4 }}>
                      {r.runs} runs
                    </span>
                    {r.errors > 0 ? (
                      <span className="modelhub-usage-error" style={{ fontSize: 9, marginLeft: 4 }}>
                        {r.errors} err
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {routingInsights && routingInsights.length > 0 ? (
          <div className="modelhub-usage">
            <div className="modelhub-h4" style={{ marginTop: 0 }}>Routing Insights</div>
            <div className="modelhub-usage-list">
              {routingInsights.map((r) => (
                <div className="modelhub-usage-row" key={`${r.profile}-${r.model}`}>
                  <span className="modelhub-routing-profile">
                    {r.profile}
                  </span>
                  <span className="modelhub-usage-model modelhub-grow" style={{ fontSize: 11 }}>
                    {r.model ?? "default"}
                  </span>
                  <span className="modelhub-usage-latency" title={`citations ${r.avgCitations.toFixed(1)} · conf ${r.avgConfidence.toFixed(2)}`}>
                    q={r.qualityScore.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {calibration && calibration.length > 0 ? (
          <div className="modelhub-usage">
            <div className="modelhub-h4" style={{ marginTop: 0 }}>Confidence Calibration</div>
            <div className="modelhub-calibration-chart">
              {calibration.map((b) => {
                const maxCite = Math.max(...calibration.map((x) => x.avgCitations), 1);
                const h = Math.max(4, (b.avgCitations / maxCite) * 44);
                return (
                  <div key={b.bucket} className="modelhub-calibration-bar">
                    <div style={{ fontSize: 8, color: "var(--muted)" }}>{b.avgCitations.toFixed(1)}</div>
                    <div className="modelhub-calibration-bar-fill" style={{ height: h }} />
                    <div style={{ fontSize: 8, color: "var(--faint)", marginTop: 2 }}>{b.bucket.toFixed(1)}</div>
                  </div>
                );
              })}
            </div>
            <div className="modelhub-footer-note" style={{ textAlign: "center" }}>
              confidence → avg citations (higher = well-calibrated)
            </div>
          </div>
        ) : null}

        {searchQuality && searchQuality.runs > 0 ? (
          <div className="modelhub-usage">
            <div className="modelhub-h4" style={{ marginTop: 0 }}>Search Quality</div>
            <div className="modelhub-usage-row">
              <span className="modelhub-note">Retrieved</span>
              <span className="modelhub-usage-model modelhub-grow" style={{ fontSize: 11 }}>
                ~{searchQuality.avgRetrieved} per query
              </span>
            </div>
            <div className="modelhub-usage-row">
              <span className="modelhub-note">Cited</span>
              <span className="modelhub-usage-model modelhub-grow" style={{ fontSize: 11 }}>
                ~{searchQuality.avgCited} per query
              </span>
            </div>
            <div className="modelhub-usage-row">
              <span className="modelhub-note">Citation rate</span>
              <span className="modelhub-usage-model modelhub-grow" style={{ fontSize: 11 }}>
                {Math.round(searchQuality.citationRate * 100)}%
              </span>
            </div>
          </div>
        ) : null}

        {keyStats && keyStats.length > 0 ? (
          <div className="modelhub-usage">
            <div className="modelhub-h4" style={{ marginTop: 0 }}>Key Pool</div>
            <div className="modelhub-usage-list">
              {keyStats.map((k) => (
                <div className="modelhub-usage-row" key={k.keyIndex}>
                  <span className="modelhub-note" style={{ width: 30 }}>k{k.keyIndex}</span>
                  <span className="modelhub-usage-model modelhub-grow" style={{ fontSize: 11 }}>
                    {k.runs} runs
                  </span>
                  <span className="modelhub-usage-latency" title={`avg latency`}>
                    ~{k.avgLatencyMs}ms
                  </span>
                  {k.errors > 0 ? (
                    <span className="modelhub-usage-error" style={{ fontSize: 9, marginLeft: 4 }}>
                      {k.errors} err ({Math.round(k.errorRate * 100)}%)
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {connectorHealth && connectorHealth.length > 0 ? (
          <div className="modelhub-usage">
            <div className="modelhub-h4" style={{ marginTop: 0 }}>Connector Health</div>
            <div className="modelhub-usage-list">
              {connectorHealth.map((c) => (
                <div className="modelhub-usage-row" key={c.connectorId}>
                  <span className="modelhub-usage-model modelhub-grow" style={{ fontSize: 11 }}>
                    {c.connectorId}
                  </span>
                  <span className="modelhub-usage-latency" title={`avg latency`}>
                    ~{c.avgLatencyMs}ms
                  </span>
                  <span className="modelhub-note" style={{ marginLeft: 4 }}>
                    {c.runs} runs
                  </span>
                  {c.errors > 0 ? (
                    <span className="modelhub-usage-error" style={{ fontSize: 9, marginLeft: 4 }}>
                      {c.errors} err ({Math.round(c.errorRate * 100)}%)
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {error ? <p className="modelhub-err" role="alert" aria-live="assertive">{error}</p> : null}
      </div>
    </div>
  );
}
