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
import { Check, Cpu, Download, X } from "lucide-react";
import { subscribeBrainBus } from "../engine/brainBus";
import { apiClient } from "../engine/apiClient";
import type { ModelPullState, ModelsView } from "../../shared/models";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ModelHubPanel({ open, onClose }: Props): JSX.Element | null {
  const [view, setView] = useState<ModelsView | null>(null);
  const [pull, setPull] = useState<ModelPullState | null>(null);
  const [customName, setCustomName] = useState("");
  const [error, setError] = useState<string | null>(null);
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
  }, [open, refresh]);

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

  if (!open) return null;

  const pct = pull?.percent != null ? Math.round(pull.percent * 100) : null;
  const installed = new Set(view?.installed ?? []);
  const pulling = pull?.active === true;

  return (
    <div className="modelhub-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Model Hub">
      <div className="modelhub" onClick={(e) => e.stopPropagation()}>
        <style>{`
          .modelhub-overlay { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
            background: rgba(4,8,14,0.6); backdrop-filter: blur(3px); font-family: ui-monospace, "JetBrains Mono", monospace; }
          .modelhub { width: min(560px, calc(100vw - 32px)); max-height: 80vh; overflow: auto;
            border: 1px solid var(--line, #1d3a44); border-radius: 14px; padding: 18px;
            background: linear-gradient(180deg, rgba(18,32,50,0.96), rgba(7,12,22,0.94)); color: #dfeef5; }
          .modelhub h3 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 15px; }
          .modelhub-close { margin-left: auto; background: transparent; border: none; color: #9fb4c9; cursor: pointer; }
          .modelhub-sub { color: #8aa1b4; font-size: 11px; margin: 6px 0 14px; line-height: 1.4; }
          .modelhub-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgba(149,238,255,0.08); }
          .modelhub-name { font-size: 12px; }
          .modelhub-note { font-size: 10px; color: #8aa1b4; }
          .modelhub-grow { flex: 1; min-width: 0; }
          .modelhub-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; padding: 4px 12px;
            border-radius: 999px; cursor: pointer; border: 1px solid var(--line, #1d3a44); background: rgba(20,30,44,0.7); color: #cfe3ef; }
          .modelhub-btn:hover { background: rgba(40,60,84,0.9); }
          .modelhub-btn.primary { background: var(--cyan, #5df2ff); color: #04222b; border-color: transparent; }
          .modelhub-btn:disabled { opacity: 0.4; cursor: default; }
          .modelhub-bar { height: 6px; border-radius: 999px; background: rgba(255,255,255,0.12); overflow: hidden; margin: 6px 0; }
          .modelhub-bar > span { display: block; height: 100%; background: var(--cyan, #5df2ff); transition: width 200ms ease; }
          .modelhub-h4 { margin: 16px 0 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #9fd9e6; }
          .modelhub-input { flex: 1; background: rgba(8,16,24,0.7); border: 1px solid var(--line,#1d3a44);
            border-radius: 8px; color: #eaf6fb; font: inherit; font-size: 12px; padding: 5px 8px; outline: none; }
          .modelhub-err { color: #ff8a8a; font-size: 11px; margin-top: 10px; }
          .modelhub-cur { color: var(--cyan,#5df2ff); }
        `}</style>

        <h3>
          <Cpu size={16} /> Model Hub
          <button className="modelhub-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </h3>
        <p className="modelhub-sub">
          Download a model and wire it into the brain. Downloads come from Ollama's registry; inference stays local.
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
            {pull.error ? <p className="modelhub-err">{pull.error}</p> : null}
          </div>
        ) : null}

        {view && view.base ? (
          <>
            <div className="modelhub-h4">Suggested chat models</div>
            {view.suggested.map((s) => {
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
                {view.installed.map((name) => (
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

        {error ? <p className="modelhub-err">{error}</p> : null}
      </div>
    </div>
  );
}
