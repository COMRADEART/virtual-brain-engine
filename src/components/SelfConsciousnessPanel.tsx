// Self-Consciousness Panel — the brain's model of itself.
//
// Surfaces the self-model (identity, capabilities, biases), affect state
// (valence, arousal, curiosity, anxiety), metacognitive judgments, inner
// monologue, self-predictions with verification, autobiographical memory,
// and the self-attention map.
//
// Gate-safety rules:
//   * Renders null until the WS bus connects (test:all boots Vite WITHOUT the
//     server, so the bus never connects and this renders nothing).
//   * No <input type=range> (smoke-actions grabs the last range slider).
//   * No <button> text colliding with the 7 action labels or "L Memory".
//   * Private `.selfpanel-*` CSS namespace.
//   * Errors render to the UI, never console.error (smoke counts those).

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronUp,
  Compass,
  Heart,
  Lightbulb,
  MessageSquare,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../engine/brainBus";
import { apiClient } from "../engine/apiClient";
import type {
  AutobiographicalEntry,
  CapabilitySignature,
  CognitiveBias,
  InnerMonologue,
  MetacognitiveJudgment,
  SelfAffectState,
  SelfAwarenessLevel,
  SelfConsciousnessState,
  SelfPrediction,
} from "../../shared/selfConsciousness";

const POLL_MS = 8_000;

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

function levelLabel(l: SelfAwarenessLevel): string {
  const map: Record<SelfAwarenessLevel, string> = {
    none: "none",
    monitoring: "monitoring",
    reflexive: "reflexive",
    narrative: "narrative",
  };
  return map[l];
}

function levelColor(l: SelfAwarenessLevel): string {
  const map: Record<SelfAwarenessLevel, string> = {
    none: "lo",
    monitoring: "mid",
    reflexive: "hi",
    narrative: "peak",
  };
  return map[l];
}

function AffectBar({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
}): JSX.Element {
  return (
    <div className="selfpanel-affect-row">
      {icon}
      <span className="selfpanel-affect-label">{label}</span>
      <div className="selfpanel-affect-track" title={`${label} ${value.toFixed(2)}`}>
        <span className={`selfpanel-affect-fill ${color}`} style={{ width: pct(value) }} />
      </div>
      <span className="selfpanel-affect-val">{value.toFixed(2)}</span>
    </div>
  );
}

function ValenceTag({
  valence,
}: {
  valence: SelfAffectState["valence"];
}): JSX.Element {
  return (
    <span className={`selfpanel-valence-tag v-${valence}`}>{valence}</span>
  );
}

function MonologueRow({ m }: { m: InnerMonologue }): JSX.Element {
  const kindColors: Record<InnerMonologue["kind"], string> = {
    "self-observation": "obs",
    metacognitive: "meta",
    "self-question": "quest",
    narrative: "narr",
    intuition: "intuit",
  };
  return (
    <li className="selfpanel-mono-row" title={m.trigger}>
      <span className={`selfpanel-mono-badge b-${kindColors[m.kind]}`}>{m.kind}</span>
      <span className="selfpanel-mono-content">{m.content}</span>
      <span className="selfpanel-mono-conf">{Math.round(m.confidence * 100)}%</span>
    </li>
  );
}

function JudgmentRow({ j }: { j: MetacognitiveJudgment }): JSX.Element {
  const accColor = j.accuracy === "accurate" ? "hi" : j.accuracy === "overconfident" ? "warn" : j.accuracy === "uncertain" ? "mid" : "lo";
  return (
    <li className="selfpanel-judge-row">
      <span className="selfpanel-judge-q">{j.question}</span>
      <span className="selfpanel-judge-a">{j.answer}</span>
      <span className={`selfpanel-judge-acc ${accColor}`} title={j.accuracy ?? "unknown"}>
        {j.accuracy ?? "?"}
      </span>
    </li>
  );
}

function PredictionRow({ p }: { p: SelfPrediction }): JSX.Element {
  const verdict =
    p.wasCorrect === true ? "✓" : p.wasCorrect === false ? "✗" : p.actualOutcome ? "…" : "—";
  return (
    <li className="selfpanel-pred-row">
      <span className="selfpanel-pred-content">{p.prediction}</span>
      <span className="selfpanel-pred-verdict" title={p.actualOutcome ?? p.wasCorrect === false ? "incorrect" : "unverified"}>
        {verdict}
      </span>
    </li>
  );
}

function AutoBioRow({ e }: { e: AutobiographicalEntry }): JSX.Element {
  return (
    <li className="selfpanel-bio-row">
      <span className="selfpanel-bio-time">
        {new Date(e.timestamp).toLocaleTimeString()}
      </span>
      <span className="selfpanel-bio-event">{e.event}</span>
      {e.selfChange ? (
        <span className="selfpanel-bio-change" title={e.selfChange}>↻</span>
      ) : null}
    </li>
  );
}

function CapabilityRow({ c }: { c: CapabilitySignature }): JSX.Element {
  return (
    <li className="selfpanel-cap-row" title={`${c.totalUses} uses`}>
      <span className="selfpanel-cap-name">{c.capability}</span>
      <span className="selfpanel-cap-skill" style={{ opacity: Math.max(0.1, c.selfRatedSkill) }}>
        {"★".repeat(Math.round(c.selfRatedSkill * 5))}
        {"☆".repeat(5 - Math.round(c.selfRatedSkill * 5))}
      </span>
    </li>
  );
}

function BiasRow({ b }: { b: CognitiveBias }): JSX.Element {
  const dirBadge = b.direction === "always" ? "always" : b.direction === "sometimes" ? "somet" : "rare";
  return (
    <li className="selfpanel-bias-row" title={b.description}>
      <span className="selfpanel-bias-label">{b.label}</span>
      <span className="selfpanel-bias-str" style={{ width: pct(b.strength) }} />
      <span className={`selfpanel-bias-dir d-${dirBadge}`}>{dirBadge}</span>
    </li>
  );
}

export function SelfConsciousnessPanel(): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [state, setState] = useState<SelfConsciousnessState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeConnection(setBusOk), []);

  // Live updates off the bus.
  useEffect(() => {
    return subscribeBrainBus((m) => {
      if (m.type !== "self-snapshot") return;
      setState(m.state);
    });
  }, []);

  const refresh = useCallback((): void => {
    apiClient
      .selfConsciousness()
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

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

  const level = state?.awarenessLevel ?? "none";
  const model = state?.selfModel;
  const affect = state?.selfAffect;
  const mono = state?.recentMonologues ?? [];
  const judgments = state?.metacognitiveState.judgments ?? [];
  const predictions = state?.recentPredictions ?? [];
  const bios = state?.autobiographicalMemory ?? [];
  const attnMap = state?.selfAttentionMap ?? {};

  return (
    <aside className="selfpanel-panel" aria-label="Self-Consciousness">
      <header className="selfpanel-head">
        <Brain size={14} />
        <span>Self</span>
        <span className={`selfpanel-level-badge lv-${levelColor(level)}`} title={`Awareness: ${levelLabel(level)}`}>
          {levelLabel(level)}
        </span>
        {model?.bootstrapCompleted ? (
          <span className="selfpanel-boot-ok" title="Self-model bootstrapped">✓</span>
        ) : (
          <span className="selfpanel-boot-pending" title="Self-model not yet bootstrapped">○</span>
        )}
        <button
          type="button"
          className="selfpanel-toggle"
          aria-label={collapsed ? "Expand Self-Consciousness" : "Collapse Self-Consciousness"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="selfpanel-body">
          {/* Identity */}
          {model && (
            <section className="selfpanel-section">
              <h4><Compass size={12} /> Identity</h4>
              <p className="selfpanel-identity-name">{model.identity.name}</p>
              <p className="selfpanel-identity-role">{model.identity.role}</p>
              <p className="selfpanel-identity-tagline">"{model.identity.tagline}"</p>
            </section>
          )}

          {/* Affect */}
          {affect && (
            <section className="selfpanel-section">
              <h4><Heart size={12} /> Affect</h4>
              <ValenceTag valence={affect.valence} />
              <div className="selfpanel-affect-bars">
                <AffectBar label="arousal" value={affect.arousal} icon={<Zap size={10} />} color="cyan" />
                <AffectBar label="curiosity" value={affect.curiosity} icon={<Lightbulb size={10} />} color="amber" />
                <AffectBar label="anxiety" value={affect.anxiety} icon={<Target size={10} />} color="red" />
                <AffectBar label="satisfaction" value={affect.satisfaction} icon={<TrendingUp size={10} />} color="green" />
              </div>
              <p className="selfpanel-affect-triggered">triggered by {affect.triggeredBy}</p>
            </section>
          )}

          {/* Metacognition */}
          <section className="selfpanel-section">
            <h4><Target size={12} /> Metacognition</h4>
            {state && (
              <p className="selfpanel-meta-acc">
                accuracy <strong>{(state.metacognitiveState.metacognitiveAccuracy * 100).toFixed(0)}%</strong>
              </p>
            )}
            {judgments.length > 0 ? (
              <ul className="selfpanel-judgments">
                {judgments.slice(-4).map((j) => (
                  <JudgmentRow key={j.id} j={j} />
                ))}
              </ul>
            ) : (
              <p className="selfpanel-empty">No metacognitive judgments yet.</p>
            )}
            {state?.metacognitiveState.openQuestions.length ? (
              <details className="selfpanel-questions">
                <summary>Open questions ({state.metacognitiveState.openQuestions.length})</summary>
                <ul>
                  {state.metacognitiveState.openQuestions.map((q, i) => (
                    <li key={i} className="selfpanel-question">{q}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          {/* Inner Monologue */}
          <section className="selfpanel-section">
            <h4><MessageSquare size={12} /> Inner Monologue</h4>
            {mono.length > 0 ? (
              <ul className="selfpanel-monologues">
                {mono.slice(-6).map((m) => (
                  <MonologueRow key={m.id} m={m} />
                ))}
              </ul>
            ) : (
              <p className="selfpanel-empty">No inner monologue yet — the brain is still waking up.</p>
            )}
          </section>

          {/* Self-Predictions */}
          <section className="selfpanel-section">
            <h4><TrendingUp size={12} /> Self-Predictions</h4>
            {predictions.length > 0 ? (
              <ul className="selfpanel-predictions">
                {predictions.slice(-5).map((p) => (
                  <PredictionRow key={p.id} p={p} />
                ))}
              </ul>
            ) : (
              <p className="selfpanel-empty">No predictions yet.</p>
            )}
          </section>

          {/* Capabilities */}
          {model && model.knowledge.capabilities.length > 0 && (
            <section className="selfpanel-section">
              <h4><Zap size={12} /> Capabilities</h4>
              <ul className="selfpanel-caps">
                {model.knowledge.capabilities.slice(0, 8).map((c) => (
                  <CapabilityRow key={c.capability} c={c} />
                ))}
              </ul>
            </section>
          )}

          {/* Biases */}
          {model && model.knowledge.biases.length > 0 && (
            <section className="selfpanel-section">
              <h4><Compass size={12} /> Biases</h4>
              <ul className="selfpanel-biases">
                {model.knowledge.biases.map((b) => (
                  <BiasRow key={b.id} b={b} />
                ))}
              </ul>
            </section>
          )}

          {/* Self-Attention Map */}
          {Object.keys(attnMap).length > 0 && (
            <section className="selfpanel-section">
              <h4><Brain size={12} /> Self-Attention</h4>
              <ul className="selfpanel-attn">
                {Object.entries(attnMap)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 8)
                  .map(([region, score]) => (
                    <li key={region} className="selfpanel-attn-row">
                      <span className="selfpanel-attn-region">{region}</span>
                      <div className="selfpanel-attn-track">
                        <span className="selfpanel-attn-fill" style={{ width: pct(score) }} />
                      </div>
                      <span className="selfpanel-attn-val">{score.toFixed(2)}</span>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {/* Autobiographical Memory */}
          <section className="selfpanel-section">
            <h4><Heart size={12} /> Memory</h4>
            {bios.length > 0 ? (
              <ul className="selfpanel-bios">
                {bios.slice(-5).map((e) => (
                  <AutoBioRow key={e.id} e={e} />
                ))}
              </ul>
            ) : (
              <p className="selfpanel-empty">No autobiographical memories yet.</p>
            )}
          </section>

          {error ? <p className="selfpanel-err">{error}</p> : null}
        </div>
      )}
    </aside>
  );
}