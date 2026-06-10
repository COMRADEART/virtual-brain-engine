import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Cloud, Cpu, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { apiClient, ApiError, type DiscoveredRuntime } from "../engine/apiClient";
import type { ConnectorDescriptor } from "../../shared/connector";

interface RuntimeRow extends DiscoveredRuntime {
  selectedModel?: string;
}

// Static metadata so users see a useful entry even when a runtime is not
// running. Order here drives the display order in the picker.
const KNOWN_RUNTIMES: Array<{
  kind: DiscoveredRuntime["kind"];
  label: string;
  installHint: string;
  installUrl: string;
  connectorKind: DiscoveredRuntime["connectorKind"];
  embedsAvailable: boolean;
  baseUrl: string;
}> = [
  { kind: "ollama", label: "Ollama", installHint: "ollama.com — fastest path; native embeddings + tool calling.", installUrl: "https://ollama.com/download", connectorKind: "ollama", embedsAvailable: true, baseUrl: "http://127.0.0.1:11434" },
  { kind: "lmstudio", label: "LM Studio", installHint: "lmstudio.ai — desktop GUI; enable the local server in Settings.", installUrl: "https://lmstudio.ai/", connectorKind: "openai-compatible", embedsAvailable: true, baseUrl: "http://127.0.0.1:1234" },
  { kind: "llamacpp", label: "llama.cpp server", installHint: "llama-server from llama.cpp.", installUrl: "https://github.com/ggml-org/llama.cpp", connectorKind: "openai-compatible", embedsAvailable: true, baseUrl: "http://127.0.0.1:8080" },
  { kind: "jan", label: "Jan", installHint: "jan.ai — Open the Local API Server tab to start.", installUrl: "https://jan.ai/", connectorKind: "openai-compatible", embedsAvailable: true, baseUrl: "http://127.0.0.1:1337" },
  { kind: "gpt4all", label: "GPT4All", installHint: "Enable 'Local API Server' in Settings.", installUrl: "https://gpt4all.io/", connectorKind: "openai-compatible", embedsAvailable: false, baseUrl: "http://127.0.0.1:4891" },
  { kind: "vllm", label: "vLLM", installHint: "vllm.ai — serve with `vllm serve <model>`.", installUrl: "https://docs.vllm.ai/", connectorKind: "openai-compatible", embedsAvailable: true, baseUrl: "http://127.0.0.1:8000" },
  { kind: "tgi", label: "Text Generation Inference", installHint: "huggingface.co/docs/text-generation-inference", installUrl: "https://huggingface.co/docs/text-generation-inference", connectorKind: "openai-compatible", embedsAvailable: false, baseUrl: "http://127.0.0.1:3000" },
];

export function RuntimePicker(): JSX.Element {
  const [runtimes, setRuntimes] = useState<DiscoveredRuntime[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  // Seeded free-tier remote providers (NVIDIA / Gemini). Present only when their
  // API key was set in .env at server boot; always non-local, opt-in.
  const [remoteConnectors, setRemoteConnectors] = useState<ConnectorDescriptor[]>([]);
  const [busyRemote, setBusyRemote] = useState<string | null>(null);
  const [remoteMsg, setRemoteMsg] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const data = await apiClient.discoverRuntimes();
      setRuntimes(data.runtimes);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        setError("Server unreachable — start it with `npm run dev:server`.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Background refresh once a minute so the picker stays live without
    // pestering the user; the user can also hit the refresh button.
    const id = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Pull the connector table so we can (a) show "Active" on the matching row and
  // (b) populate the remote-provider section with any seeded NVIDIA/Gemini rows.
  const loadConnectors = useCallback(async () => {
    try {
      const { connectors } = await apiClient.listConnectors();
      const def = connectors.find((c) => c.isDefault && c.enabled);
      setActiveId(def?.id ?? null);
      setRemoteConnectors(connectors.filter((c) => !c.isLocal));
    } catch {
      // Server unreachable — keep whatever we last had; the local-runtime
      // refresh path already surfaces the connection error.
    }
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors, runtimes]);

  const rows: RuntimeRow[] = useMemo(() => {
    return KNOWN_RUNTIMES.map((meta) => {
      const live = runtimes.find((r) => r.kind === meta.kind);
      if (live) {
        return { ...live, selectedModel: selected[meta.kind] ?? live.models[0] };
      }
      // Placeholder row for an undetected runtime.
      return {
        kind: meta.kind,
        label: meta.label,
        baseUrl: meta.baseUrl,
        state: "unreachable" as const,
        models: [],
        embedsAvailable: meta.embedsAvailable,
        connectorKind: meta.connectorKind,
      };
    });
  }, [runtimes, selected]);

  const handleSelect = useCallback(
    async (row: RuntimeRow) => {
      if (row.state === "unreachable" || row.models.length === 0) {
        return;
      }
      const model = selected[row.kind] ?? row.models[0];
      setBusyKind(row.kind);
      setError(null);
      try {
        const { connector } = await apiClient.selectConnector({
          runtimeKind: row.kind,
          kind: row.connectorKind,
          baseUrl: row.baseUrl,
          model,
        });
        setActiveId(connector.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKind(null);
      }
    },
    [selected],
  );

  // Make a seeded remote provider the pipeline default. Path-1 select by id —
  // the server flips is_default + enabled on the existing row.
  const activateRemote = useCallback(
    async (connector: ConnectorDescriptor) => {
      setBusyRemote(connector.id);
      setError(null);
      try {
        const { connector: updated } = await apiClient.selectConnector({ connectorId: connector.id });
        setActiveId(updated.id);
        await loadConnectors();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyRemote(null);
      }
    },
    [loadConnectors],
  );

  // Verify the key/host without switching to it — the one network call that
  // actually reaches the provider, triggered explicitly by the user.
  const testRemote = useCallback(
    async (id: string) => {
      setBusyRemote(id);
      setRemoteMsg((m) => ({ ...m, [id]: "Testing…" }));
      try {
        const result = await apiClient.testConnector(id);
        setRemoteMsg((m) => ({
          ...m,
          [id]: result.ok
            ? result.message ?? "Reachable"
            : result.message ?? "Test failed",
        }));
        await loadConnectors();
      } catch (err) {
        setRemoteMsg((m) => ({ ...m, [id]: err instanceof Error ? err.message : String(err) }));
      } finally {
        setBusyRemote(null);
      }
    },
    [loadConnectors],
  );

  return (
    <div className="brain-os-section">
      <header className="status-row">
        <span>Local LLM runtimes</span>
        <button
          className="ai-icon-button"
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh"
          style={{ marginLeft: "auto" }}
        >
          {refreshing ? <Loader2 size={14} className="ai-spin" /> : <RefreshCw size={14} />}
        </button>
      </header>
      <small className="status-detail">
        Probes 7 known runtimes on loopback. Pick one to make it the pipeline's default.
      </small>
      {error ? <p className="ai-error">{error}</p> : null}
      <ul className="runtime-list">
        {rows.map((row) => {
          const reachable = row.state !== "unreachable";
          const ready = row.state === "ok";
          const installMeta = KNOWN_RUNTIMES.find((k) => k.kind === row.kind)!;
          const isActive = activeId === `auto-${row.kind}`;
          return (
            <li key={row.kind} className={`runtime-row ${row.state}`}>
              <div className="runtime-head">
                <span
                  className={`status-dot ${
                    ready ? "live" : row.state === "ok-no-model" ? "pending" : "offline"
                  }`}
                />
                <Cpu size={14} />
                <strong>{row.label}</strong>
                {isActive ? (
                  <span className="runtime-active" title="Active default">
                    <CheckCircle2 size={12} /> Active
                  </span>
                ) : null}
                <small className="runtime-port">:{row.baseUrl.split(":").pop()}</small>
              </div>
              {ready ? (
                <div className="runtime-body">
                  <label className="runtime-model-label">
                    Model
                    <select
                      value={selected[row.kind] ?? row.models[0]}
                      onChange={(e) =>
                        setSelected((s) => ({ ...s, [row.kind]: e.target.value }))
                      }
                    >
                      {row.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="ai-send"
                    type="button"
                    disabled={busyKind === row.kind || isActive}
                    onClick={() => void handleSelect(row)}
                  >
                    {busyKind === row.kind ? (
                      <Loader2 size={12} className="ai-spin" />
                    ) : null}
                    {isActive ? "In use" : "Use this"}
                  </button>
                </div>
              ) : row.state === "ok-no-model" ? (
                <p className="ai-hint">
                  Running, but no model is loaded. Open the {row.label} app and load one.
                </p>
              ) : (
                <p className="ai-hint">
                  Not detected on {row.baseUrl}. {installMeta.installHint}{" "}
                  <a
                    href={installMeta.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="runtime-link"
                  >
                    Install <ExternalLink size={11} />
                  </a>
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <header className="status-row" style={{ marginTop: "0.75rem" }}>
        <Cloud size={14} />
        <span>Remote providers (free tier)</span>
      </header>
      <small className="status-detail">
        Stronger cloud models, opt-in. Local Ollama stays the default until you pick
        one. Embeddings always stay local, so retrieval is unaffected.
      </small>
      {remoteConnectors.length === 0 ? (
        <p className="ai-hint">
          None configured. Add <code>NVIDIA_API_KEY</code> or <code>GEMINI_API_KEY</code>{" "}
          to your <code>.env</code> (see <code>.env.example</code>) and restart the server.
          Free keys:{" "}
          <a href="https://build.nvidia.com" target="_blank" rel="noopener noreferrer" className="runtime-link">
            build.nvidia.com <ExternalLink size={11} />
          </a>{" "}
          /{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="runtime-link">
            aistudio.google.com/apikey <ExternalLink size={11} />
          </a>
          .
        </p>
      ) : (
        <ul className="runtime-list">
          {remoteConnectors.map((c) => {
            const isActive = activeId === c.id;
            const busy = busyRemote === c.id;
            return (
              <li key={c.id} className={`runtime-row ${c.state}`}>
                <div className="runtime-head">
                  <span className={`status-dot ${c.state === "ok" ? "live" : "offline"}`} />
                  <Cloud size={14} />
                  <strong>{c.name}</strong>
                  {isActive ? (
                    <span className="runtime-active" title="Active default">
                      <CheckCircle2 size={12} /> Active
                    </span>
                  ) : null}
                </div>
                <div className="runtime-body">
                  <small className="runtime-model-label">Model: {c.model ?? "—"}</small>
                  <button
                    className="ai-icon-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void testRemote(c.id)}
                  >
                    {busy ? <Loader2 size={12} className="ai-spin" /> : null} Test
                  </button>
                  <button
                    className="ai-send"
                    type="button"
                    disabled={busy || isActive}
                    onClick={() => void activateRemote(c)}
                  >
                    {busy ? <Loader2 size={12} className="ai-spin" /> : null}
                    {isActive ? "In use" : "Use this"}
                  </button>
                </div>
                {remoteMsg[c.id] ? <p className="ai-hint">{remoteMsg[c.id]}</p> : null}
                {c.lastError && !remoteMsg[c.id] ? <p className="ai-error">{c.lastError}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
