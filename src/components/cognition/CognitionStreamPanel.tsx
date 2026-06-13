// Cognition Stream Panel — the organism's running inner life, live.
//
// Renders the unified `cognition` bus stream (beliefs forming/updating, goals
// growing, curiosity spikes, reflections, dreams, thoughts, monologues,
// procedures learned, stage advances) as a newest-first feed, with the
// developmental stage (1-7) in the header (initial fetch from
// GET /api/brain/kernel, then live `stage-advance` events).
//
// Gate-safety rules (the SelfConsciousnessPanel contract):
//   * Renders null until the WS bus connects.
//   * No <input type=range>; no <button> text colliding with action labels.
//   * Private `.cogstream-*` CSS namespace.
//   * Errors render to the UI, never console.error.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../../engine/brainBus";
import { apiClient } from "../../engine/apiClient";
import type { DevelopmentalStageInfo } from "../../../shared/cognition";
import {
  KIND_BADGE,
  KIND_CLASS,
  pushCognitionEvent,
  type StreamEntry,
} from "./cognitionStream";

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export interface CognitionStreamPanelProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function CognitionStreamPanel({
  collapsed,
  onCollapsedChange,
}: CognitionStreamPanelProps): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [events, setEvents] = useState<StreamEntry[]>([]);
  const [stage, setStage] = useState<DevelopmentalStageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => subscribeConnection(setBusOk), []);

  // The live stream — also tracks stage advances without re-fetching.
  useEffect(() => {
    return subscribeBrainBus((m) => {
      if (m.type !== "cognition") return;
      seqRef.current += 1;
      const seq = seqRef.current;
      setEvents((prev) => pushCognitionEvent(prev, m.event, seq));
      if (m.event.kind === "stage-advance") {
        const parsed = /stage (\d)/i.exec(m.event.label);
        if (parsed) {
          setStage((prev) => ({
            stage: Number(parsed[1]),
            name: m.event.label.split(": ")[1] ?? prev?.name ?? "",
            reachedAt: m.event.at,
          }));
        }
      }
    });
  }, []);

  // Initial stage fetch once the bus is up (the kernel is the status surface).
  useEffect(() => {
    if (!busOk) return;
    let cancelled = false;
    apiClient
      .brainKernel()
      .then((k) => {
        if (!cancelled) {
          setStage(k.stage);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [busOk]);

  if (!busOk) return null;

  return (
    <aside className="cogstream-panel" aria-label="Cognition Stream">
      <header className="cogstream-head">
        <Sparkles size={14} />
        <span>Cognition</span>
        {stage && (
          <span
            className="cogstream-stage-badge"
            title={`Developmental stage ${stage.stage} of 7 — ${stage.name} (since ${stage.reachedAt})`}
          >
            stage {stage.stage}/7 · {stage.name}
          </span>
        )}
        <button
          type="button"
          className="cogstream-toggle"
          aria-label={collapsed ? "Expand Cognition Stream" : "Collapse Cognition Stream"}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="cogstream-body">
          {error && <p className="cogstream-error">kernel unreachable: {error}</p>}
          {events.length === 0 ? (
            <p className="cogstream-empty">
              No mental acts yet — the stream fills as the brain thinks, forms
              beliefs, grows goals, reflects, and dreams.
            </p>
          ) : (
            <ul className="cogstream-list">
              {events.map((e) => (
                <li key={e.seq} className={`cogstream-row k-${KIND_CLASS[e.kind]}`} title={e.reason}>
                  <span className="cogstream-badge">{KIND_BADGE[e.kind]}</span>
                  <span className="cogstream-label">
                    {e.label}
                    {e.detail ? <small className="cogstream-detail"> — {e.detail}</small> : null}
                  </span>
                  <span
                    className="cogstream-mag"
                    style={{ opacity: 0.25 + 0.75 * e.magnitude }}
                    title={`magnitude ${e.magnitude.toFixed(2)}`}
                  />
                  <span className="cogstream-time">{timeOf(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
