// Spinal Cord Panel — the brain↔body conduit, live.
//
// Shows the spine subsystem the server runs: the three descending tracts
// (reflex / motor-program / deliberate), the motor-pool personas (OpenClaw),
// the reflex arcs (NanoClaw), and a live feed of motor commands travelling the
// cord. A dispatch box sends ONE descending intent down /api/spine/dispatch and
// streams the route it took + the result. The 3D spine column animates from the
// same `spine` bus events (see BrainScene).
//
// Gate-safety (the CognitionStreamPanel contract): renders null until the WS bus
// connects; no <input type=range>; icon-only action button (no text colliding
// with the 7 region-action labels); private `.spine-*` CSS namespace; errors
// render to the UI, never console.error.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GitBranch, Send } from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../engine/brainBus";
import { apiClient } from "../engine/apiClient";
import type { SpineEvent, SpinalPersona, SpinalPersonaId, SpinalTract } from "../../shared/spine";

interface FeedEntry {
  seq: number;
  ev: SpineEvent;
}

const TRACT_CLASS: Record<SpinalTract, string> = {
  reflex: "reflex",
  program: "program",
  deliberate: "deliberate",
};

const KIND_LABEL: Record<SpineEvent["kind"], string> = {
  "command-queued": "queued",
  "reflex-fired": "reflex",
  "program-run": "program",
  dispatched: "deliberate",
  feedback: "← feedback",
};

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export interface SpinePanelProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function SpinePanel({ collapsed, onCollapsedChange }: SpinePanelProps): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [personas, setPersonas] = useState<SpinalPersona[]>([]);
  const [reflexCount, setReflexCount] = useState(0);
  const [tractCounts, setTractCounts] = useState<Record<SpinalTract, number>>({ reflex: 0, program: 0, deliberate: 0 });
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [intent, setIntent] = useState("");
  const [persona, setPersona] = useState<SpinalPersonaId | "auto">("auto");
  const [allowActions, setAllowActions] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [route, setRoute] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => subscribeConnection(setBusOk), []);

  // Initial status fetch once the bus is up.
  useEffect(() => {
    if (!busOk) return;
    let cancelled = false;
    apiClient
      .spineState()
      .then((s) => {
        if (cancelled) return;
        setPersonas(s.personas);
        setReflexCount(s.reflexes.length);
        setTractCounts(s.tractCounts);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [busOk]);

  // Live feed — every motor command travelling the cord (any tab's activity).
  useEffect(() => {
    return subscribeBrainBus((m) => {
      if (m.type !== "spine") return;
      seqRef.current += 1;
      const seq = seqRef.current;
      setFeed((prev) => [{ seq, ev: m.event }, ...prev].slice(0, 40));
      if (m.event.kind === "reflex-fired") setTractCounts((c) => ({ ...c, reflex: c.reflex + 1 }));
      else if (m.event.kind === "program-run") setTractCounts((c) => ({ ...c, program: c.program + 1 }));
      else if (m.event.kind === "dispatched") setTractCounts((c) => ({ ...c, deliberate: c.deliberate + 1 }));
    });
  }, []);

  async function dispatch(): Promise<void> {
    const text = intent.trim();
    if (!text || streaming) return;
    setStreaming(true);
    setRoute(null);
    setAnswer("");
    setError(null);
    try {
      const stream = apiClient.spineDispatch({
        intent: text,
        personaId: persona === "auto" ? undefined : persona,
        confirmMode: allowActions ? "scope" : "safe-only",
        scope: allowActions ? { allow: ["safe", "confirm"] } : { allow: [] },
      });
      for await (const frame of stream) {
        if ("type" in frame && frame.type === "spine") {
          if (frame.event.tract) setRoute(frame.event.tract);
        } else if ("type" in frame && frame.type === "delta" && typeof frame.text === "string") {
          setAnswer((a) => a + frame.text);
        } else if ("type" in frame && frame.type === "final" && typeof frame.text === "string") {
          setAnswer(frame.text);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  }

  if (!busOk) return null;

  return (
    <aside className="spine-panel" aria-label="Spinal Cord">
      <header className="spine-head">
        <GitBranch size={14} />
        <span>Spinal cord</span>
        <span className="spine-counts" title="commands by tract">
          <em className="t-reflex">{tractCounts.reflex}</em>
          <em className="t-program">{tractCounts.program}</em>
          <em className="t-deliberate">{tractCounts.deliberate}</em>
        </span>
        <button
          type="button"
          className="spine-toggle"
          aria-label={collapsed ? "Expand Spinal Cord" : "Collapse Spinal Cord"}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="spine-body">
          {error && <p className="spine-error">{error}</p>}

          <form
            className="spine-dispatch"
            onSubmit={(e) => {
              e.preventDefault();
              void dispatch();
            }}
          >
            <input
              className="spine-input"
              type="text"
              placeholder="Send an intent down the cord…"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              disabled={streaming}
            />
            <select
              className="spine-persona"
              value={persona}
              onChange={(e) => setPersona(e.target.value as SpinalPersonaId | "auto")}
              disabled={streaming}
              aria-label="Motor pool"
            >
              <option value="auto">auto</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="spine-send"
              aria-label="Dispatch intent down the cord"
              disabled={streaming || intent.trim().length === 0}
            >
              <Send size={13} />
            </button>
          </form>
          <label className="spine-allow" title="Let the deliberate tract run confirm-tier actions within a session scope (instead of refusing them).">
            <input type="checkbox" checked={allowActions} onChange={(e) => setAllowActions(e.target.checked)} disabled={streaming} />
            allow actions (session scope)
          </label>

          {(route || answer || streaming) && (
            <div className="spine-result">
              {route && <span className={`spine-route t-${TRACT_CLASS[route as SpinalTract] ?? "deliberate"}`}>{route} tract</span>}
              {streaming && !answer && <span className="spine-working">…travelling the cord</span>}
              {answer && <p className="spine-answer">{answer}</p>}
            </div>
          )}

          <div className="spine-meta">
            <span title={`${personas.length} motor pools`}>{personas.length} pools</span>
            <span title={`${reflexCount} reflex arcs`}>{reflexCount} reflexes</span>
          </div>

          {feed.length === 0 ? (
            <p className="spine-empty">No motor commands yet — dispatch an intent, or watch the cord light up when the brain acts.</p>
          ) : (
            <ul className="spine-feed">
              {feed.map((f) => (
                <li key={f.seq} className={`spine-row t-${f.ev.tract ? TRACT_CLASS[f.ev.tract] : "queued"}`} title={f.ev.detail ?? ""}>
                  <span className="spine-kind">{KIND_LABEL[f.ev.kind]}</span>
                  <span className="spine-intent">{f.ev.intent}</span>
                  {f.ev.ok === false && <span className="spine-blocked">blocked</span>}
                  <span className="spine-time">{timeOf(f.ev.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
