// Learning Lab — surfaces the brain's OWN learning (Phase B):
//   * the from-scratch learning-to-rank model that trains online on implicit
//     citations + explicit 👍/👎 (warm-up, loss curve, learned weights);
//   * 👍/👎 feedback tally;
//   * the optional from-scratch PyTorch LLM trainer (Phase C) — trained on the
//     user's OWN memory corpus, with an honest "educational, not a brain
//     upgrade" framing.
//
// Gate-safety rules (mirror PerceptionPanel.tsx — the smoke tests assume them):
//   * Renders null until the WS bus connects (test:all boots Vite WITHOUT the
//     server, so the bus never connects and this renders nothing).
//   * No <input type=range> (smoke-actions grabs the last range slider).
//   * No <button> text colliding with the 7 action labels or "L Memory".
//   * Private `.learnlab-*` CSS namespace.
//   * Errors render to the UI, never console.error (smoke counts those).

import { useCallback, useEffect, useState } from "react";
import { Activity, ChevronDown, ChevronUp, Cpu, GraduationCap, ThumbsDown, ThumbsUp } from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../engine/brainBus";
import { apiClient } from "../engine/apiClient";
import type { LearningStatus, LlmTrainerStatus, LossPoint } from "../../shared/learning";
import type { IngestStatus, IngestSourceId } from "../../shared/ingest";

const STATUS_POLL_MS = 5_000;
// Poll the (separate) trainer status faster while it's actively running so the
// step/loss/sample tick along; fall back to the slow cadence otherwise.
const TRAINING_POLL_MS = 2_000;

function LossSparkline({ points }: { points: LossPoint[] }): JSX.Element {
  if (points.length < 2) {
    return <p className="learnlab-empty">Loss curve appears once the ranker has trained on a few queries.</p>;
  }
  const w = 240;
  const h = 48;
  const losses = points.map((p) => p.loss);
  const min = Math.min(...losses);
  const max = Math.max(...losses);
  const span = max - min || 1;
  const stepX = w / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = h - ((p.loss - min) / span) * (h - 6) - 3;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="learnlab-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Ranker training loss over time">
      <path d={path} fill="none" stroke="var(--cyan)" strokeWidth={1.5} />
    </svg>
  );
}

function WeightBars({ weights }: { weights: LearningStatus["ranker"]["weights"] }): JSX.Element {
  const maxAbs = Math.max(1e-6, ...weights.map((w) => Math.abs(w.weight)));
  return (
    <ul className="learnlab-weights">
      {weights.map((w) => {
        const pct = (Math.abs(w.weight) / maxAbs) * 50; // half-width = center-out
        const positive = w.weight >= 0;
        return (
          <li key={w.label} className="learnlab-weight-row">
            <span className="learnlab-weight-label">{w.label}</span>
            <span className="learnlab-weight-track">
              <span
                className={`learnlab-weight-fill ${positive ? "pos" : "neg"}`}
                style={{ width: `${pct}%`, [positive ? "left" : "right"]: "50%" } as React.CSSProperties}
              />
            </span>
            <span className="learnlab-weight-val">{w.weight >= 0 ? "+" : ""}{w.weight.toFixed(2)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function trainerTone(s: LlmTrainerStatus): "down" | "idle" | "running" | "done" | "error" {
  switch (s.state) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "unavailable":
      return "down";
    default:
      return "idle";
  }
}

export function LearningLabPanel(): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [llm, setLlm] = useState<LlmTrainerStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);

  useEffect(() => subscribeConnection(setBusOk), []);

  // Refresh on explicit-feedback broadcasts so the tally + warm-up update live
  // even when the feedback came from another tab.
  useEffect(() => {
    return subscribeBrainBus((m) => {
      if (m.type !== "learning-update") return;
      setStatus((prev) =>
        prev
          ? { ...prev, feedback: { ...prev.feedback, ...m.feedback }, ranker: { ...prev.ranker, trainedCount: m.trainedCount } }
          : prev,
      );
    });
  }, []);

  const refresh = useCallback((): void => {
    apiClient
      .learningStatus()
      .then((s) => {
        setStatus(s);
        setLlm(s.llm);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // Ingest source consent state — independent so a failure here doesn't blank
    // the ranker view.
    apiClient.ingestStatus().then(setIngest).catch(() => {});
  }, []);

  const toggleSource = useCallback(async (id: IngestSourceId, enabled: boolean): Promise<void> => {
    try {
      const r = await apiClient.ingestSetConsent(id, !enabled);
      setIngest(r.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll while open + bus connected. Faster cadence while the LLM trainer runs.
  useEffect(() => {
    if (!busOk || collapsed) return;
    let cancelled = false;
    refresh();
    const running = llm?.state === "running";
    const id = window.setInterval(() => {
      if (cancelled) return;
      if (running) {
        apiClient.learningLlmStatus().then((s) => !cancelled && setLlm(s)).catch(() => {});
      } else {
        refresh();
      }
    }, running ? TRAINING_POLL_MS : STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [busOk, collapsed, refresh, llm?.state]);

  const startTraining = useCallback((): void => {
    setStarting(true);
    setError(null);
    apiClient
      .learningTrainLlm({})
      .then((s) => setLlm(s))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setStarting(false));
  }, []);

  if (!busOk) return null;

  const ranker = status?.ranker;
  const feedback = status?.feedback;
  const trainer = llm ?? status?.llm ?? null;
  const tone = trainer ? trainerTone(trainer) : "down";

  return (
    <aside className="learnlab-panel" aria-label="Learning Lab">
      <header className="learnlab-head">
        <GraduationCap size={14} />
        <span>Learning Lab</span>
        {ranker ? (
          <small className={`learnlab-badge ${ranker.warm ? "warm" : "cold"}`}>
            {ranker.warm ? "warm" : `α ${ranker.alpha.toFixed(2)}`}
          </small>
        ) : null}
        <button
          type="button"
          className="learnlab-toggle"
          aria-label={collapsed ? "Expand Learning Lab" : "Collapse Learning Lab"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="learnlab-body">
          {/* ---- Online ranker (the model that's ALREADY training) ---- */}
          <section className="learnlab-section">
            <h4>
              <Activity size={12} /> Online ranker
            </h4>
            {ranker ? (
              <>
                <p className="learnlab-sub">
                  Trained on <strong>{ranker.trainedCount}</strong> cited queries · warms up at {ranker.warmAt}
                </p>
                <div className="learnlab-progress" title={`α = ${ranker.alpha.toFixed(2)} (blend toward the learned model)`}>
                  <span className="learnlab-progress-fill" style={{ width: `${Math.round(ranker.alpha * 100)}%` }} />
                </div>
                <LossSparkline points={status?.loss ?? []} />
                <WeightBars weights={ranker.weights} />
              </>
            ) : (
              <p className="learnlab-empty">Loading…</p>
            )}
          </section>

          {/* ---- Explicit feedback tally ---- */}
          {feedback ? (
            <section className="learnlab-section">
              <h4>Feedback signal</h4>
              <div className="learnlab-feedback">
                <span className="learnlab-fb up"><ThumbsUp size={12} /> {feedback.up}</span>
                <span className="learnlab-fb down"><ThumbsDown size={12} /> {feedback.down}</span>
                <small>{feedback.total} rated answer{feedback.total === 1 ? "" : "s"}</small>
              </div>
            </section>
          ) : null}

          {/* ---- Phase 4: learning from use (commands + ingestion) ---- */}
          {status?.usage ? (
            <section className="learnlab-section">
              <h4>
                <Activity size={12} /> Learning from use
              </h4>
              <ul className="learnlab-metrics">
                <li>commands <strong>{status.usage.actions.total}</strong></li>
                <li>success <strong>{Math.round(status.usage.actions.successRate * 100)}%</strong></li>
                <li>ingested <strong>{status.usage.ingest.totalIngested}</strong></li>
              </ul>
              <div className="learnlab-feedback">
                <span className="learnlab-fb up"><ThumbsUp size={12} /> {status.usage.memoryFeedback.up}</span>
                <span className="learnlab-fb down"><ThumbsDown size={12} /> {status.usage.memoryFeedback.down}</span>
                <small>memory verdicts</small>
              </div>
            </section>
          ) : null}

          {/* ---- Phase 2: computer-wide memory sources (opt-in consent) ---- */}
          {ingest ? (
            <section className="learnlab-section">
              <h4>Memory sources</h4>
              <p className="learnlab-note">Opt-in. Captured text is redacted + deduped before storage.</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {ingest.sources.map((s) => (
                  <li
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "3px 0",
                    }}
                  >
                    <span title={s.description} style={{ fontSize: 12 }}>
                      {s.title}
                    </span>
                    <button
                      type="button"
                      aria-pressed={s.enabled}
                      onClick={() => void toggleSource(s.id, s.enabled)}
                      style={{
                        fontSize: 10,
                        padding: "2px 12px",
                        borderRadius: 999,
                        cursor: "pointer",
                        border: "1px solid var(--line)",
                        background: s.enabled ? "var(--cyan)" : "transparent",
                        color: s.enabled ? "#04222b" : "#9fb4c9",
                      }}
                    >
                      {s.enabled ? "on" : "off"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* ---- From-scratch LLM trainer (Phase C) ---- */}
          <section className="learnlab-section">
            <h4>
              <Cpu size={12} /> From-scratch LLM
              <small className={`learnlab-status learnlab-status-${tone}`}>
                {trainer?.state ?? "…"}
              </small>
            </h4>
            <p className="learnlab-note">
              A tiny GPT trained from zero on your own memories. Educational — it learns your
              corpus's texture, not a capable assistant.
            </p>
            {trainer && trainer.state === "unavailable" ? (
              <p className="learnlab-hint">
                {trainer.message ?? "Trainer offline."} Start <code>worker/</code> with{" "}
                <code>pip install -r requirements-ml.txt</code>.
              </p>
            ) : null}
            {trainer && trainer.state !== "unavailable" ? (
              <div className="learnlab-trainer">
                {trainer.totalSteps > 0 ? (
                  <div className="learnlab-progress">
                    <span
                      className="learnlab-progress-fill alt"
                      style={{ width: `${Math.round((trainer.step / Math.max(1, trainer.totalSteps)) * 100)}%` }}
                    />
                  </div>
                ) : null}
                <ul className="learnlab-metrics">
                  <li>step <strong>{trainer.step}{trainer.totalSteps ? `/${trainer.totalSteps}` : ""}</strong></li>
                  {trainer.loss !== null ? <li>loss <strong>{trainer.loss.toFixed(3)}</strong></li> : null}
                  {trainer.valLoss !== null ? <li>val <strong>{trainer.valLoss.toFixed(3)}</strong></li> : null}
                  {trainer.params !== null ? <li><strong>{(trainer.params / 1e6).toFixed(2)}M</strong> params</li> : null}
                  {trainer.vocabSize !== null ? <li>vocab <strong>{trainer.vocabSize}</strong></li> : null}
                  {trainer.corpusChars !== null ? <li><strong>{(trainer.corpusChars / 1000).toFixed(0)}k</strong> chars</li> : null}
                </ul>
                {trainer.sample ? <pre className="learnlab-sample">{trainer.sample}</pre> : null}
              </div>
            ) : null}
            <button
              type="button"
              className="learnlab-btn"
              disabled={starting || trainer?.state === "running"}
              onClick={startTraining}
            >
              <GraduationCap size={12} /> {trainer?.state === "running" ? "Training…" : "Train from my memories"}
            </button>
          </section>

          {error ? <p className="learnlab-err">{error}</p> : null}
        </div>
      )}
    </aside>
  );
}
