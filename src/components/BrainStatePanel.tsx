// Brain State — the unified cognitive-loop dashboard.
//
// STAR's attention, working memory, goals and confidence used to live in
// separate subsystems with no shared view. This panel surfaces the single
// persistent BrainState the central loop reads/writes: the attention map (with
// the saliency breakdown that earned it), the decaying working-memory
// workspace, the active goal set, and the confidence + feed-forward
// priorUncertainty that closes the loop. Updates live off the bus.
//
// Gate-safety rules (mirror LearningLabPanel.tsx — the smoke tests assume them):
//   * Renders null until the WS bus connects (test:all boots Vite WITHOUT the
//     server, so the bus never connects and this renders nothing).
//   * No <input type=range> (smoke-actions grabs the last range slider).
//   * No <button> text colliding with the 7 action labels or "L Memory".
//   * Private `.brainstate-*` CSS namespace.
//   * Errors render to the UI, never console.error (smoke counts those).

import { useCallback, useEffect, useState } from "react";
import { Activity, Brain, ChevronDown, ChevronUp, Eye, Gauge, Layers, Target } from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../engine/brainBus";
import { apiClient } from "../engine/apiClient";
import type { AttentionFocus, BrainStateSnapshot, WorkingItem } from "../../shared/brainState";

const POLL_MS = 6_000;

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

function ConfidenceGauge({ confidence, prior }: { confidence: number; prior: number }): JSX.Element {
  // Confidence as a filled bar; priorUncertainty as a thin marker beneath — the
  // feed-forward signal that broadens the next retrieval.
  const tone = confidence >= 0.6 ? "hi" : confidence >= 0.35 ? "mid" : "lo";
  return (
    <div className="brainstate-gauge">
      <div className="brainstate-gauge-track">
        <span className={`brainstate-gauge-fill ${tone}`} style={{ width: pct(confidence) }} />
      </div>
      <div className="brainstate-gauge-row">
        <small>confidence <strong>{confidence.toFixed(2)}</strong></small>
        <small>feed-forward uncertainty <strong>{prior.toFixed(2)}</strong></small>
      </div>
    </div>
  );
}

function AttentionRow({ focus }: { focus: AttentionFocus }): JSX.Element {
  const b = focus.breakdown;
  const parts: Array<[string, number]> = [
    ["nov", b.novelty],
    ["goal", b.goalRelevance],
    ["emo", b.emotion],
    ["surv", b.survival],
    ["unc", b.uncertainty],
  ];
  return (
    <li className="brainstate-attn-row" title={focus.label}>
      <span className="brainstate-attn-score">{focus.score.toFixed(2)}</span>
      <span className="brainstate-attn-label">{focus.label || "(memory)"}</span>
      <span className="brainstate-attn-bars" aria-hidden="true">
        {parts.map(([k, v]) => (
          <span key={k} className={`brainstate-attn-seg seg-${k}`} style={{ height: pct(v) }} title={`${k} ${v.toFixed(2)}`} />
        ))}
      </span>
    </li>
  );
}

function WorkingRow({ item }: { item: WorkingItem }): JSX.Element {
  return (
    <li className={`brainstate-wm-row kind-${item.kind}`} title={`${item.kind} · activation ${item.activation.toFixed(2)}`}>
      <span className="brainstate-wm-kind">{item.kind}</span>
      <span className="brainstate-wm-label">{item.label}</span>
      <span className="brainstate-wm-track">
        <span className="brainstate-wm-fill" style={{ width: pct(item.activation) }} />
      </span>
    </li>
  );
}

export function BrainStatePanel(): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [snap, setSnap] = useState<BrainStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeConnection(setBusOk), []);

  // Live updates off the bus — the loop broadcasts a throttled snapshot.
  useEffect(() => {
    return subscribeBrainBus((m) => {
      if (m.type !== "brain-state") return;
      setSnap(m.snapshot);
    });
  }, []);

  const refresh = useCallback((): void => {
    apiClient
      .brainState()
      .then((s) => {
        setSnap(s);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Poll while open + connected (the bus push covers live changes; this seeds
  // the view + recovers if a push was missed).
  useEffect(() => {
    if (!busOk || collapsed) return;
    let cancelled = false;
    refresh();
    const id = window.setInterval(() => {
      if (!cancelled) refresh();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [busOk, collapsed, refresh]);

  if (!busOk) return null;

  const confidence = snap?.confidence ?? 0;
  const prior = snap?.priorUncertainty ?? 0;
  const learning = snap?.learning;

  return (
    <aside className="brainstate-panel" aria-label="Brain State">
      <header className="brainstate-head">
        <Brain size={14} />
        <span>Brain State</span>
        {snap ? (
          <small className={`brainstate-badge ${confidence >= 0.6 ? "hi" : confidence >= 0.35 ? "mid" : "lo"}`}>
            {snap.cycles} cycle{snap.cycles === 1 ? "" : "s"}
          </small>
        ) : null}
        <button
          type="button"
          className="brainstate-toggle"
          aria-label={collapsed ? "Expand Brain State" : "Collapse Brain State"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="brainstate-body">
          {/* Confidence + feed-forward (the loop closing) */}
          <section className="brainstate-section">
            <h4><Gauge size={12} /> Metacognition</h4>
            <ConfidenceGauge confidence={confidence} prior={prior} />
            {snap?.lastCycle?.lowConfidence ? (
              <p className="brainstate-note warn">
                Last cycle was low-confidence — held as an open question; next query attends broader.
              </p>
            ) : null}
          </section>

          {/* Attention map */}
          <section className="brainstate-section">
            <h4><Eye size={12} /> Attention</h4>
            {snap && snap.attention.length > 0 ? (
              <ul className="brainstate-attn">
                {snap.attention.map((f) => (
                  <AttentionRow key={f.id} focus={f} />
                ))}
              </ul>
            ) : (
              <p className="brainstate-empty">No attention yet — ask the brain something.</p>
            )}
          </section>

          {/* Working memory */}
          <section className="brainstate-section">
            <h4><Layers size={12} /> Working memory</h4>
            {snap && snap.workingMemory.length > 0 ? (
              <ul className="brainstate-wm">
                {snap.workingMemory.map((w) => (
                  <WorkingRow key={w.id} item={w} />
                ))}
              </ul>
            ) : (
              <p className="brainstate-empty">Workspace is quiet.</p>
            )}
          </section>

          {/* Goal graph */}
          <section className="brainstate-section">
            <h4><Target size={12} /> Goals</h4>
            {snap && snap.goals.length > 0 ? (
              <ul className="brainstate-goals">
                {snap.goals.map((g, i) => (
                  <li key={`${g.title}-${i}`} className="brainstate-goal-row">
                    <span className="brainstate-goal-pri">{g.priority}</span>
                    <span className="brainstate-goal-title" title={g.title}>{g.title}</span>
                    <span className={`brainstate-goal-status st-${g.status}`}>{g.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="brainstate-empty">No active goals.</p>
            )}
          </section>

          {/* Learning metrics */}
          {learning ? (
            <section className="brainstate-section">
              <h4><Activity size={12} /> Learning</h4>
              <ul className="brainstate-metrics">
                <li>ranker <strong>{learning.rankerWarm ? "warm" : `α ${learning.rankerAlpha.toFixed(2)}`}</strong></li>
                <li>trained <strong>{learning.trainedCount}</strong></li>
                {learning.lossLast !== null ? <li>loss <strong>{learning.lossLast.toFixed(3)}</strong></li> : null}
                <li>👍 <strong>{learning.feedbackUp}</strong> · 👎 <strong>{learning.feedbackDown}</strong></li>
              </ul>
            </section>
          ) : null}

          {error ? <p className="brainstate-err">{error}</p> : null}
        </div>
      )}
    </aside>
  );
}
