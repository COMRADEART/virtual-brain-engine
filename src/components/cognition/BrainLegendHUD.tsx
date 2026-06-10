// BrainLegendHUD — membrane-potential legend, EEG band labels, neuromod readouts
// ==============================================================================
//
// Phase 4 (improvement plan §11 UX consolidation): the data already exists in
// the spiking engine (BrainOscillations + NeuromodulationSystem) and shows up
// visually in the scene (membrane-coloured neurons, EEG waveform, neuromod
// tints) but the user has no key to read it. This HUD provides the key.
//
// Self-gates on the active HybridCognitiveCore (same registry as CognitivePanel)
// so it only renders when ?useHybrid=true. Pure presentational — polls the
// active engine at ~7 Hz, never per-frame.

import { useEffect, useState, type CSSProperties } from "react";
import { HybridCognitiveCore } from "../../engine/cognition/HybridCognitiveCore";

interface NeuromodSnap {
  dopamine: number;
  acetylcholine: number;
  serotonin: number;
  norepinephrine: number;
}

// Mirror of NEURON_FRAG's four-stop membrane gradient (BrainVisualEffects.ts).
// Keep these in sync — they're the legend the user is reading.
const MEMBRANE_STOPS = [
  { mv: -75, label: "reset", color: "#150162" },
  { mv: -70, label: "rest", color: "#0d59b8" },
  { mv: -60, label: "threshold", color: "#00d9bf" },
  { mv: -52, label: "firing", color: "#fff32f" },
];

// Five canonical EEG bands. Range labels are the conventional clinical bands.
const EEG_BANDS = [
  { name: "δ delta", range: "0.5–4 Hz", color: "#7c3aed" },
  { name: "θ theta", range: "4–8 Hz", color: "#3b82f6" },
  { name: "α alpha", range: "8–13 Hz", color: "#10b981" },
  { name: "β beta", range: "13–30 Hz", color: "#f59e0b" },
  { name: "γ gamma", range: "30–100 Hz", color: "#f43f5e" },
];

// Neuromodulator → screen colour + display name. The tint colours mirror the
// hand-picked values in NEURON_FRAG.getNeuromodulatorTint so the legend matches
// what the user sees in the scene.
const NEUROMOD_SPECS: ReadonlyArray<{
  key: keyof NeuromodSnap;
  label: string;
  short: string;
  color: string;
}> = [
  { key: "dopamine", label: "Dopamine — reward / salience", short: "DA", color: "#f97316" },
  { key: "acetylcholine", label: "Acetylcholine — attention", short: "ACh", color: "#06b6d4" },
  { key: "serotonin", label: "Serotonin — mood / consolidation", short: "5HT", color: "#a855f7" },
  { key: "norepinephrine", label: "Norepinephrine — arousal", short: "NE", color: "#22c55e" },
];

export function BrainLegendHUD(): JSX.Element | null {
  const [engine, setEngine] = useState<HybridCognitiveCore | null>(() =>
    HybridCognitiveCore.getActive(),
  );
  const [nm, setNm] = useState<NeuromodSnap | null>(null);

  useEffect(() => HybridCognitiveCore.subscribeActive(setEngine), []);

  useEffect(() => {
    if (!engine) {
      setNm(null);
      return;
    }
    const id = window.setInterval(() => {
      setNm({
        dopamine: engine.dopamine,
        acetylcholine: engine.acetylcholine,
        serotonin: engine.serotonin,
        norepinephrine: engine.norepinephrine,
      });
    }, 150);
    return () => window.clearInterval(id);
  }, [engine]);

  if (!engine || !nm) return null;

  const membraneGradient = `linear-gradient(90deg, ${MEMBRANE_STOPS.map((s) => s.color).join(", ")})`;

  return (
    <aside style={S.panel} aria-label="Brain legend">
      <div style={S.section}>
        <div style={S.sectionTitle}>Membrane potential</div>
        <div style={{ ...S.bar, background: membraneGradient }} />
        <div style={S.tickRow}>
          {MEMBRANE_STOPS.map((s) => (
            <span key={s.mv} style={S.tick}>
              {s.mv} mV
            </span>
          ))}
        </div>
        <div style={S.subRow}>
          {MEMBRANE_STOPS.map((s) => (
            <span key={s.label} style={S.subLabel}>
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>EEG bands</div>
        <div style={S.bandRow}>
          {EEG_BANDS.map((b) => (
            <span key={b.name} style={{ ...S.band, color: b.color }}>
              <span style={{ ...S.bandSwatch, background: b.color }} />
              <span style={S.bandText}>
                {b.name}
                <span style={S.bandRange}> · {b.range}</span>
              </span>
            </span>
          ))}
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>Neuromodulators</div>
        {NEUROMOD_SPECS.map(({ key, short, label, color }) => {
          const v = Math.max(0, Math.min(1, nm[key]));
          return (
            <div key={key} style={S.nmRow} title={label}>
              <span style={S.nmShort}>{short}</span>
              <div style={S.nmTrack}>
                <div style={{ ...S.nmFill, width: `${v * 100}%`, background: color }} />
              </div>
              <span style={S.nmValue}>{v.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

const S: Record<string, CSSProperties> = {
  panel: {
    position: "fixed",
    bottom: 76,
    left: 16,
    width: 248,
    padding: "10px 12px",
    background: "rgba(10, 14, 24, 0.82)",
    border: "1px solid rgba(120, 140, 180, 0.25)",
    borderRadius: 12,
    backdropFilter: "blur(8px)",
    color: "#e2e8f0",
    font: "10.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    zIndex: 38,
    pointerEvents: "none",
    boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
  },
  section: { marginBottom: 10 },
  sectionTitle: {
    color: "#cbd5e1",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 5,
  },
  bar: { height: 8, borderRadius: 4, marginBottom: 4 },
  tickRow: { display: "flex", justifyContent: "space-between", color: "#94a3b8", fontSize: 9 },
  subRow: { display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: 8.5, marginTop: 1 },
  tick: { width: "25%", textAlign: "center" as CSSProperties["textAlign"] },
  subLabel: { width: "25%", textAlign: "center" as CSSProperties["textAlign"] },
  bandRow: { display: "flex", flexDirection: "column", gap: 3 },
  band: { display: "flex", alignItems: "center", gap: 5 },
  bandSwatch: { width: 10, height: 8, borderRadius: 2, display: "inline-block" },
  bandText: { color: "#e2e8f0", fontSize: 10 },
  bandRange: { color: "#94a3b8", fontSize: 9.5 },
  nmRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 3 },
  nmShort: { width: 26, color: "#94a3b8", fontSize: 9.5, letterSpacing: 0.4 },
  nmTrack: { flex: 1, height: 6, background: "rgba(148,163,184,0.15)", borderRadius: 3, overflow: "hidden" },
  nmFill: { height: "100%", borderRadius: 3 },
  nmValue: { width: 30, textAlign: "right" as CSSProperties["textAlign"], color: "#cbd5e1", fontSize: 9.5 },
};
