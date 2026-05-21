import { useEffect, useRef, useState } from "react";
import { Activity, Cpu, Database, LayoutGrid, Sparkles, Zap } from "lucide-react";
import { subscribeBrainBus } from "../engine/brainBus";
import {
  MODE_LABELS,
  PERF_PRESETS,
  presetNeuronCount,
  type PerfMode,
  type PerfPresetId,
} from "../engine/performancePresets";
import { LAYOUT_LABELS, type LayoutMode } from "../engine/useLayoutMode";

interface StatusBarProps {
  mode: PerfMode;
  /** The tier actually in effect — equals mode unless Auto, where the
   *  adaptive controller picks it. */
  effectiveTier: PerfPresetId;
  onCyclePreset: () => void;
  layout: LayoutMode;
  onCycleLayout: () => void;
}

interface Stats {
  fps: number;
  ramMb: number | null;
  tps: number;
  mem: number;
}

export function StatusBar({
  mode,
  effectiveTier,
  onCyclePreset,
  layout,
  onCycleLayout,
}: StatusBarProps): JSX.Element {
  const presetLabel =
    mode === "auto"
      ? `Auto·${PERF_PRESETS[effectiveTier].label}`
      : MODE_LABELS[mode];
  const [stats, setStats] = useState<Stats>({ fps: 0, ramMb: null, tps: 0, mem: 0 });
  // Latest rolling work summary from the SummaryAgent (COMPUTER BRAIN layer).
  const [summary, setSummary] = useState<string>("");
  const frames = useRef(0);
  const tokens = useRef(0);
  const memCount = useRef(0);

  // rAF sampler counts frames but only writes React state once per second
  // (1 Hz, not 60 Hz) — it does not lift per-frame simulation state.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      frames.current += 1;
      const now = performance.now();
      if (now - last >= 1000) {
        const perf = performance as Performance & {
          memory?: { usedJSHeapSize: number };
        };
        setStats({
          fps: frames.current,
          ramMb: perf.memory ? Math.round(perf.memory.usedJSHeapSize / 1048576) : null,
          tps: tokens.current,
          mem: memCount.current,
        });
        frames.current = 0;
        tokens.current = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type === "memory-count") {
        memCount.current = message.count;
        return;
      }
      if (message.type === "summary-created") {
        setSummary(message.summary);
        return;
      }
      if (
        message.type === "pipeline" &&
        message.step === "response" &&
        message.status === "progress" &&
        message.tokensDelta
      ) {
        // Rough estimate: ~4 chars per token.
        tokens.current += Math.max(1, Math.round(message.tokensDelta.length / 4));
      }
    });
  }, []);

  return (
    <footer className="status-bar" aria-label="System status">
      <span className={stats.fps > 0 && stats.fps < 30 ? "stat warn" : "stat"}>
        <Activity size={12} />
        {stats.fps} fps
      </span>
      {stats.ramMb !== null && (
        <span className="stat">
          <Cpu size={12} />
          {stats.ramMb} MB
        </span>
      )}
      <span className="stat">
        <Zap size={12} />
        {stats.tps} tok/s
      </span>
      <span className="stat">
        <Database size={12} />
        {stats.mem.toLocaleString()} mem
      </span>
      {summary && (
        <span className="stat" title={summary}>
          <Sparkles size={12} />
          {summary.length > 48 ? `${summary.slice(0, 48)}…` : summary}
        </span>
      )}
      <button
        className="stat chip"
        onClick={onCycleLayout}
        title="Cycle layout (Compact / Focus / Full) — L"
      >
        <LayoutGrid size={12} />
        {LAYOUT_LABELS[layout]}
      </button>
      <button
        className="stat chip preset"
        onClick={onCyclePreset}
        title="Cycle performance preset (Light / Balanced / Cinematic / Auto) — P"
      >
        {presetLabel} · {presetNeuronCount(effectiveTier).toLocaleString()}n
      </button>
    </footer>
  );
}
