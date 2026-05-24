// CognitivePanel — live HUD for the hybrid cognitive layer
// ========================================================
//
// A self-contained, opt-in overlay that visualises what the higher-cognition
// stack is doing: which thinking system is in control, the composite-IQ growth
// curve (with the held-out probe overlaid), the reward-prediction-error trace,
// the affective state, and the System 2 introspection feed.
//
// It finds the live engine through HybridCognitiveCore's static registry, so no
// props need threading through App → BrainScene. It renders NOTHING unless a
// hybrid engine is active (i.e. the app was opened with ?useHybrid=true), and it
// updates React state at ~7 Hz (NOT per frame), pushing high-frequency signals
// (RPE) through refs — honouring the project rule that per-frame simulation state
// must never drive React re-renders.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HybridCognitiveCore } from "../../engine/cognition/HybridCognitiveCore";
import type { CognitiveMode } from "../../engine/cognition/cognitionTypes";

interface Snap {
  mode: CognitiveMode;
  uncertainty: number;
  iq: number;
  probe: number;
  components: Record<string, number>;
  valence: number;
  arousal: number;
  generation: number;
  samples: number;
}

const MODE_COLOR: Record<CognitiveMode, string> = {
  system1: "#38bdf8", // fast/intuitive — cyan
  hybrid: "#a78bfa", // mixed — violet
  system2: "#f472b6", // deliberate — pink
};

const MODE_LABEL: Record<CognitiveMode, string> = {
  system1: "System 1 · intuitive",
  hybrid: "Hybrid",
  system2: "System 2 · deliberate",
};

export function CognitivePanel(): JSX.Element | null {
  const [engine, setEngine] = useState<HybridCognitiveCore | null>(() =>
    HybridCognitiveCore.getActive(),
  );
  const [snap, setSnap] = useState<Snap | null>(null);
  const [feed, setFeed] = useState<string[]>([]);
  const iqRing = useRef<number[]>([]);
  const probeRing = useRef<number[]>([]);
  const rpeRing = useRef<number[]>([]);

  // Track the active engine (set/cleared by HybridCognitiveCore on build/dispose).
  useEffect(() => HybridCognitiveCore.subscribeActive(setEngine), []);

  // Subscribe + poll the active engine.
  useEffect(() => {
    if (!engine) {
      setSnap(null);
      setFeed([]);
      iqRing.current = [];
      probeRing.current = [];
      rpeRing.current = [];
      return;
    }
    const offRpe = engine.bus.on("rl:rpe", (p) => {
      const r = rpeRing.current;
      r.push(p.delta);
      if (r.length > 64) r.shift();
    });
    const offReason = engine.bus.on("reason:step", (p) => {
      setFeed((f) => [p.explain, ...f].slice(0, 6));
    });
    const id = window.setInterval(() => {
      const rep = engine.getIQReport();
      const aff = engine.getAffect();
      iqRing.current.push(rep.value);
      if (iqRing.current.length > 96) iqRing.current.shift();
      probeRing.current.push(rep.probe);
      if (probeRing.current.length > 96) probeRing.current.shift();
      setSnap({
        mode: engine.getCognitiveMode(),
        uncertainty: engine.getUncertainty(),
        iq: rep.value,
        probe: rep.probe,
        components: rep.components,
        valence: aff.valence,
        arousal: aff.arousal,
        generation: engine.getGeneration(),
        samples: rep.samples,
      });
    }, 150);
    return () => {
      offRpe();
      offReason();
      window.clearInterval(id);
    };
  }, [engine]);

  if (!engine || !snap) return null;

  const rpe = rpeRing.current.length ? rpeRing.current[rpeRing.current.length - 1] : 0;

  return (
    <aside style={S.panel} aria-label="Cognitive state">
      {/* Mode badge + uncertainty */}
      <div style={S.headerRow}>
        <span style={{ ...S.badge, background: MODE_COLOR[snap.mode] }}>{MODE_LABEL[snap.mode]}</span>
        <span style={S.gen}>gen {snap.generation}</span>
      </div>
      <Meter label="Uncertainty" value={snap.uncertainty} color="#fbbf24" />

      {/* IQ headline + growth curve (probe overlaid as the anti-Goodhart canary) */}
      <div style={S.iqRow}>
        <div>
          <div style={S.iqValue}>{Math.round(snap.iq)}</div>
          <div style={S.iqCaption}>effective IQ · {snap.samples} episodes</div>
        </div>
        <Sparkline
          series={[
            { points: iqRing.current, color: "#34d399", min: 40, max: 200 },
            { points: probeRing.current.map((p) => 40 + p * 160), color: "#64748b", min: 40, max: 200 },
          ]}
        />
      </div>

      {/* Reward-prediction error (dopamine teaching signal) */}
      <div style={S.rpeRow}>
        <span style={S.smallLabel}>RPE δ</span>
        <div style={S.rpeBarTrack}>
          <div
            style={{
              ...S.rpeBarFill,
              width: `${Math.min(50, Math.abs(rpe) * 120)}%`,
              left: rpe >= 0 ? "50%" : undefined,
              right: rpe < 0 ? "50%" : undefined,
              background: rpe >= 0 ? "#34d399" : "#f87171",
            }}
          />
          <div style={S.rpeZero} />
        </div>
      </div>

      {/* Affect: valence/arousal dot */}
      <div style={S.affectRow}>
        <span style={S.smallLabel}>Affect</span>
        <div style={S.affectBox}>
          <div
            style={{
              ...S.affectDot,
              left: `${((snap.valence + 1) / 2) * 100}%`,
              bottom: `${snap.arousal * 100}%`,
            }}
          />
        </div>
        <span style={S.affectCaption}>
          {snap.valence >= 0 ? "+" : ""}
          {snap.valence.toFixed(2)} v · {snap.arousal.toFixed(2)} a
        </span>
      </div>

      {/* IQ sub-scores */}
      <div style={S.components}>
        {Object.entries(snap.components).map(([k, v]) => (
          <Meter key={k} label={shortName(k)} value={v} color="#60a5fa" compact />
        ))}
      </div>

      {/* System 2 introspection feed */}
      {feed.length > 0 && (
        <div style={S.feed}>
          <div style={S.smallLabel}>Reasoning</div>
          {feed.map((line, i) => (
            <div key={`${i}-${line.slice(0, 12)}`} style={{ ...S.feedLine, opacity: 1 - i * 0.13 }}>
              {line}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────────

function Meter({
  label,
  value,
  color,
  compact,
}: {
  label: string;
  value: number;
  color: string;
  compact?: boolean;
}): JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div style={{ marginBottom: compact ? 3 : 6 }}>
      <div style={S.meterLabelRow}>
        <span style={S.smallLabel}>{label}</span>
        {!compact && <span style={S.smallLabel}>{Math.round(pct)}%</span>}
      </div>
      <div style={S.meterTrack}>
        <div style={{ ...S.meterFill, width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

interface Series {
  points: number[];
  color: string;
  min: number;
  max: number;
}

function Sparkline({ series }: { series: Series[] }): JSX.Element {
  const w = 120;
  const h = 40;
  const path = (s: Series): string => {
    if (s.points.length < 2) return "";
    const span = Math.max(1e-6, s.max - s.min);
    return s.points
      .map((p, i) => {
        const x = (i / (s.points.length - 1)) * w;
        const y = h - ((p - s.min) / span) * h;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  return (
    <svg width={w} height={h} style={S.spark}>
      {series.map((s, i) => (
        <path
          key={i}
          d={path(s)}
          fill="none"
          stroke={s.color}
          strokeWidth={i === 0 ? 1.8 : 1}
          strokeDasharray={i === 0 ? undefined : "3 2"}
        />
      ))}
    </svg>
  );
}

function shortName(key: string): string {
  switch (key) {
    case "predictionAccuracy":
      return "predict";
    case "problemSolving":
      return "solve";
    case "adaptationSpeed":
      return "adapt";
    case "reasoningDepth":
      return "reason";
    default:
      return key;
  }
}

// ── Inline styles (self-contained; no CSS dependency) ─────────────────────────

const S: Record<string, CSSProperties> = {
  panel: {
    position: "fixed",
    top: 16,
    right: 16,
    width: 240,
    padding: "12px 14px",
    background: "rgba(10, 14, 24, 0.82)",
    border: "1px solid rgba(120, 140, 180, 0.25)",
    borderRadius: 12,
    backdropFilter: "blur(8px)",
    color: "#e2e8f0",
    font: "11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    zIndex: 40,
    pointerEvents: "none",
    boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
  },
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  badge: { padding: "3px 8px", borderRadius: 999, color: "#0b1220", fontWeight: 700, fontSize: 10 },
  gen: { color: "#94a3b8", fontSize: 10 },
  iqRow: { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 0" },
  iqValue: { fontSize: 28, fontWeight: 800, color: "#34d399", lineHeight: 1 },
  iqCaption: { color: "#94a3b8", fontSize: 9, marginTop: 2 },
  spark: { overflow: "visible" },
  rpeRow: { display: "flex", alignItems: "center", gap: 6, margin: "4px 0" },
  rpeBarTrack: {
    position: "relative",
    flex: 1,
    height: 8,
    background: "rgba(148,163,184,0.15)",
    borderRadius: 4,
    overflow: "hidden",
  },
  rpeBarFill: { position: "absolute", top: 0, height: "100%", borderRadius: 4 },
  rpeZero: { position: "absolute", left: "50%", top: 0, width: 1, height: "100%", background: "rgba(226,232,240,0.4)" },
  affectRow: { display: "flex", alignItems: "center", gap: 6, margin: "6px 0" },
  affectBox: {
    position: "relative",
    width: 44,
    height: 44,
    background: "rgba(148,163,184,0.12)",
    border: "1px solid rgba(148,163,184,0.2)",
    borderRadius: 6,
  },
  affectDot: {
    position: "absolute",
    width: 8,
    height: 8,
    marginLeft: -4,
    marginBottom: -4,
    borderRadius: 999,
    background: "#fbbf24",
    boxShadow: "0 0 8px #fbbf24",
  },
  affectCaption: { color: "#94a3b8", fontSize: 9 },
  components: { marginTop: 8 },
  meterLabelRow: { display: "flex", justifyContent: "space-between" },
  smallLabel: { color: "#94a3b8", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 },
  meterTrack: { height: 5, background: "rgba(148,163,184,0.15)", borderRadius: 3, overflow: "hidden" },
  meterFill: { height: "100%", borderRadius: 3 },
  feed: { marginTop: 10, borderTop: "1px solid rgba(148,163,184,0.18)", paddingTop: 8 },
  feedLine: { fontSize: 9.5, color: "#cbd5e1", marginTop: 4, lineHeight: 1.35 },
};
