import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BrainCircuit,
  Clock,
  Database,
  Eye,
  GitBranch,
  Loader2,
  RefreshCw,
  Shield,
  Sparkles,
  Workflow,
} from "lucide-react";
import { apiClient } from "../engine/apiClient";
import { subscribeBrainBus } from "../engine/brainBus";
import type {
  ImaginationFuture,
  ImaginationSession,
  ImaginationSnapshot,
  ImaginationTimelineEntry,
} from "../../shared/imagination";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function shortMs(value: number): string {
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function futureClass(future: ImaginationFuture, recommended: boolean): string {
  const risk = future.risk >= 0.55 ? "hot" : future.risk >= 0.32 ? "warm" : "cool";
  return `imagination-future ${future.kind} ${risk} ${recommended ? "recommended" : ""}`;
}

function timelineLabel(entry: ImaginationTimelineEntry): string {
  switch (entry.kind) {
    case "future-predicted":
      return "future";
    case "future-recommended":
      return "choice";
    case "prediction-corrected":
      return "reflect";
    case "abstraction-formed":
      return "abstract";
    case "dream-consolidated":
      return "dream";
    default:
      return "thought";
  }
}

function FutureMap({ session }: { session: ImaginationSession | null }): JSX.Element {
  const futures = session?.futures ?? [];
  const recommendedId = session?.recommendation.futureId;
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    futures.forEach((future, index) => {
      const y = 16 + index * (68 / Math.max(1, futures.length - 1 || 1));
      const x = 16 + future.score * 66;
      map.set(future.id, { x, y });
    });
    return map;
  }, [futures]);

  return (
    <div className="imagination-map">
      <svg viewBox="0 0 100 100" role="img" aria-label="Future branches">
        <path className="imagination-trunk" d="M8 50 C 24 50, 24 50, 38 50" />
        {futures.map((future) => {
          const pos = positions.get(future.id);
          if (!pos) return null;
          return (
            <g key={future.id}>
              <path
                className={future.id === recommendedId ? "recommended" : ""}
                d={`M38 50 C 50 ${50 + (pos.y - 50) * 0.25}, 58 ${pos.y}, ${pos.x} ${pos.y}`}
              />
              <circle
                className={`future-dot ${future.risk >= 0.55 ? "hot" : future.risk >= 0.32 ? "warm" : "cool"} ${
                  future.id === recommendedId ? "recommended" : ""
                }`}
                cx={pos.x}
                cy={pos.y}
                r={future.id === recommendedId ? 3.8 : 2.8}
              />
              <title>{`${future.label}: ${pct(future.confidence)} confidence`}</title>
            </g>
          );
        })}
      </svg>
      <div className="imagination-map-meta">
        <span>{futures.length} futures</span>
        <span>{session ? pct(session.recommendation.confidence) : "0%"} confidence</span>
      </div>
    </div>
  );
}

export function ImaginationPanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<ImaginationSnapshot | null>(null);
  const [active, setActive] = useState<ImaginationSession | null>(null);
  const [goal, setGoal] = useState("Upgrade Rust dependencies");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await apiClient.imagination();
      setSnapshot(next);
      setActive((current) => current ?? next.sessions[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type === "imagination-snapshot") {
        setSnapshot(message.snapshot);
        setActive((current) => current ?? message.snapshot.sessions[0] ?? null);
      }
      if (message.type === "imagination-session") {
        setActive(message.session);
      }
    });
  }, []);

  const simulate = useCallback(async () => {
    const text = goal.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.imaginationSimulate({
        goal: text,
        action: text,
        mode: "workflow-rehearsal",
        branchCount: 5,
        context: { source: "imagination-panel" },
      });
      setActive(result.session);
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [goal]);

  const dream = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.imaginationDream();
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const reflectRecommended = useCallback(async () => {
    if (!active) return;
    const future = active.futures.find((candidate) => candidate.id === active.recommendation.futureId);
    if (!future) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.imaginationReflect({
        sessionId: active.id,
        futureId: future.id,
        actualSummary: `${future.label} stayed in mental rehearsal; no real workspace action was executed.`,
        ok: true,
        actualDurationMs: future.resourceForecast.estimatedDurationMs,
        actualRisk: future.risk,
      });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [active]);

  const sessions = snapshot?.sessions ?? [];
  const timeline = snapshot?.timeline ?? [];
  const reflections = snapshot?.reflections ?? [];
  const abstractions = snapshot?.abstractions ?? [];
  const recommended = active?.futures.find((future) => future.id === active.recommendation.futureId) ?? null;

  return (
    <div className="imagination-panel">
      <div className="phase2-toolbar">
        <div className="phase2-title">
          <Sparkles size={15} />
          <span>Imagination</span>
        </div>
        <button className="unified-btn small" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      {error ? <div className="unified-error">{error}</div> : null}

      <div className="phase2-input-row">
        <input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void simulate();
          }}
          placeholder="Mental rehearsal goal"
        />
        <button className="unified-btn send" type="button" onClick={() => void simulate()} disabled={!goal.trim() || busy}>
          <BrainCircuit size={13} />
        </button>
      </div>

      <div className="phase2-stat-grid">
        <div>
          <GitBranch size={14} />
          <strong>{active?.futures.length ?? 0}</strong>
          <span>futures</span>
        </div>
        <div>
          <Shield size={14} />
          <strong>{recommended ? pct(recommended.risk) : "0%"}</strong>
          <span>risk</span>
        </div>
        <div>
          <Eye size={14} />
          <strong>{recommended ? pct(recommended.confidence) : "0%"}</strong>
          <span>confidence</span>
        </div>
        <div>
          <Clock size={14} />
          <strong>{recommended ? shortMs(recommended.resourceForecast.estimatedDurationMs) : "0s"}</strong>
          <span>duration</span>
        </div>
      </div>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <GitBranch size={13} />
          <span>Branching Futures</span>
        </div>
        <FutureMap session={active} />
      </section>

      <section className="phase2-section imagination-actions">
        <button className="phase2-wide-action" type="button" onClick={() => void reflectRecommended()} disabled={!active || busy}>
          <Workflow size={13} />
          <span>Compare predicted / actual</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void dream()} disabled={busy}>
          <Database size={13} />
          <span>Consolidate</span>
        </button>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Activity size={13} />
          <span>Future Set</span>
        </div>
        <div className="imagination-future-list">
          {(active?.futures ?? []).map((future) => (
            <button
              key={future.id}
              className={futureClass(future, future.id === active?.recommendation.futureId)}
              type="button"
            >
              <div>
                <strong>{future.label}</strong>
                <span>{future.kind}</span>
              </div>
              <p>{future.summary}</p>
              <div className="imagination-bars">
                <span style={{ width: pct(future.confidence) }} />
                <span style={{ width: pct(future.risk) }} />
              </div>
              <small>{`${pct(future.executionProbability)} execution / ${pct(future.ambiguity)} ambiguity`}</small>
            </button>
          ))}
          {!active ? <small className="phase2-muted">No simulations yet</small> : null}
        </div>
      </section>

      <section className="phase2-section phase2-two-col">
        <div>
          <div className="phase2-section-head">
            <BrainCircuit size={13} />
            <span>Thought Space</span>
          </div>
          <div className="imagination-thoughts">
            {(active?.thoughtSpace ?? []).map((thought) => (
              <div key={thought.id}>
                <strong>{thought.visibility}</strong>
                <span>{thought.content}</span>
              </div>
            ))}
            {!active ? <small className="phase2-muted">No private thoughts</small> : null}
          </div>
        </div>
        <div>
          <div className="phase2-section-head">
            <Database size={13} />
            <span>Abstractions</span>
          </div>
          <div className="imagination-abstractions">
            {abstractions.slice(0, 5).map((abstraction) => (
              <div key={abstraction.id}>
                <strong>{abstraction.concept}</strong>
                <span>{pct(abstraction.confidence)}</span>
              </div>
            ))}
            {abstractions.length === 0 ? <small className="phase2-muted">No abstractions yet</small> : null}
          </div>
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Workflow size={13} />
          <span>Cognitive Timeline</span>
        </div>
        <div className="imagination-timeline">
          {timeline.slice(0, 9).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                const session = sessions.find((candidate) => candidate.id === entry.sessionId);
                if (session) setActive(session);
              }}
            >
              <span>{timelineLabel(entry)}</span>
              <strong>{entry.title}</strong>
              <small>{shortTime(entry.createdAt)}</small>
            </button>
          ))}
          {timeline.length === 0 ? <small className="phase2-muted">No future timeline</small> : null}
        </div>
      </section>

      {reflections.length > 0 ? (
        <section className="phase2-section">
          <div className="phase2-section-head">
            <Shield size={13} />
            <span>Reflection</span>
          </div>
          <div className="imagination-reflections">
            {reflections.slice(0, 3).map((reflection) => (
              <div key={reflection.id}>
                <strong>{pct(reflection.accuracy)}</strong>
                <span>{reflection.lesson}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
