import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BrainCircuit,
  CalendarClock,
  GitBranch,
  Loader2,
  Network,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Workflow,
} from "lucide-react";
import { apiClient } from "../engine/apiClient";
import type {
  ContextSnapshot,
  GraphSnapshotOutput,
  Phase2Status,
  SemanticSearchHit,
  TemporalEvent,
  WorkflowSnapshotOutput,
} from "../../shared/phase2";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function nodePosition(index: number, total: number): { x: number; y: number } {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  const radius = total > 10 ? 38 : 32;
  return {
    x: 50 + Math.cos(angle) * radius,
    y: 50 + Math.sin(angle) * radius,
  };
}

function GraphMini({ graph }: { graph: GraphSnapshotOutput | null }): JSX.Element {
  const nodes = useMemo(() => graph?.nodes.slice(0, 28) ?? [], [graph]);
  const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const edges = useMemo(
    () => (graph?.edges ?? []).filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId)).slice(0, 60),
    [graph, nodeIds],
  );
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    nodes.forEach((node, index) => map.set(node.id, nodePosition(index, nodes.length)));
    return map;
  }, [nodes]);

  return (
    <div className="phase2-graph-mini">
      <svg viewBox="0 0 100 100" role="img" aria-label="Knowledge graph">
        {edges.map((edge) => {
          const from = positions.get(edge.fromId);
          const to = positions.get(edge.toId);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              strokeWidth={Math.max(0.25, edge.weight)}
            />
          );
        })}
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          return (
            <g key={node.id} transform={`translate(${pos.x} ${pos.y})`}>
              <circle className={`phase2-node ${node.kind}`} r={node.kind === "project" ? 3.4 : 2.4} />
              <title>{node.label}</title>
            </g>
          );
        })}
      </svg>
      <div className="phase2-graph-meta">
        <span>{graph?.nodes.length ?? 0} nodes</span>
        <span>{graph?.edges.length ?? 0} edges</span>
      </div>
    </div>
  );
}

export function Phase2CortexPanel(): JSX.Element {
  const [status, setStatus] = useState<Phase2Status | null>(null);
  const [graph, setGraph] = useState<GraphSnapshotOutput | null>(null);
  const [timeline, setTimeline] = useState<TemporalEvent[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowSnapshotOutput | null>(null);
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [hits, setHits] = useState<SemanticSearchHit[]>([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [nextStatus, nextGraph, nextTimeline, nextWorkflow] = await Promise.all([
        apiClient.phase2Status(),
        apiClient.phase2Graph(),
        apiClient.phase2Timeline(18),
        apiClient.phase2WorkflowSnapshot(),
      ]);
      setStatus(nextStatus);
      setGraph(nextGraph);
      setTimeline(nextTimeline);
      setWorkflow(nextWorkflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runSearch = useCallback(async () => {
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.phase2SemanticSearch({ query: text, limit: 10, minScore: 0.1 });
      setHits(result.hits);
      const snapshot = await apiClient.phase2Context({ prompt: text });
      setContext(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [query]);

  const ingestNote = useCallback(async () => {
    const content = note.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.phase2SemanticIngest({
        content,
        memoryType: "manual",
        tags: ["phase-2", "manual"],
        importance: 0.66,
      });
      await refresh();
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [note, refresh]);

  const seedAutomation = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.phase2ScheduleTask({
        kind: "nightly-project-summary",
        title: "Nightly project summary",
        intervalMinutes: 1440,
        priority: 55,
      });
      await apiClient.phase2WorkflowEnqueue({
        agent: "ProjectAgent",
        action: "refresh-project-intelligence",
        priority: 58,
        payload: { source: "phase2-dashboard" },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="phase2-cortex">
      <div className="phase2-toolbar">
        <div className="phase2-title">
          <BrainCircuit size={15} />
          <span>Cortex</span>
        </div>
        <button className="unified-btn small" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      {error ? <div className="unified-error">{error}</div> : null}

      <div className="phase2-stat-grid">
        <div>
          <DatabaseGlyph />
          <strong>{status?.semantic_memories ?? 0}</strong>
          <span>semantic</span>
        </div>
        <div>
          <Network size={14} />
          <strong>{status?.graph_nodes ?? 0}</strong>
          <span>nodes</span>
        </div>
        <div>
          <Workflow size={14} />
          <strong>{status?.pending_workflows ?? 0}</strong>
          <span>queued</span>
        </div>
        <div>
          <Sparkles size={14} />
          <strong>{status?.mood.mood ?? "idle"}</strong>
          <span>{status ? pct(status.mood.focus) : "0%"}</span>
        </div>
      </div>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Search size={13} />
          <span>Semantic Search</span>
        </div>
        <div className="phase2-input-row">
          <input
            value={query}
            placeholder="Search cognitive memory"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
          />
          <button className="unified-btn send" type="button" disabled={!query.trim() || busy} onClick={() => void runSearch()}>
            <Search size={13} />
          </button>
        </div>
        {context ? (
          <div className="phase2-context">
            <span>{context.likely_intent}</span>
            <small>{context.summary}</small>
          </div>
        ) : null}
        <div className="phase2-hit-list">
          {hits.map((hit) => (
            <div key={hit.memory_id} className="phase2-hit">
              <div>
                <strong>{Math.round(hit.score * 100)}%</strong>
                <span>{hit.memory_type}</span>
              </div>
              <p>{hit.content_preview}</p>
              <small>{hit.source_path ?? hit.project_name ?? hit.reasons.join(", ")}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="phase2-section phase2-two-col">
        <div>
          <div className="phase2-section-head">
            <GitBranch size={13} />
            <span>Knowledge Graph</span>
          </div>
          <GraphMini graph={graph} />
        </div>
        <div>
          <div className="phase2-section-head">
            <Activity size={13} />
            <span>Agents</span>
          </div>
          <div className="phase2-agent-list">
            {(workflow?.tasks ?? []).slice(0, 5).map((task) => (
              <div key={task.id}>
                <strong>{task.agent}</strong>
                <span>{task.action}</span>
                <small>{task.state}</small>
              </div>
            ))}
            {(workflow?.tasks.length ?? 0) === 0 ? <small className="phase2-muted">No queued workflow</small> : null}
          </div>
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <CalendarClock size={13} />
          <span>Memory Timeline</span>
        </div>
        <div className="phase2-timeline">
          {timeline.slice(0, 8).map((event) => (
            <div key={event.id}>
              <span>{event.kind}</span>
              <strong>{event.title}</strong>
              <small>{shortDate(event.occurred_at)}</small>
            </div>
          ))}
          {timeline.length === 0 ? <small className="phase2-muted">No timeline events</small> : null}
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Radar size={13} />
          <span>Memory Evolution</span>
        </div>
        <div className="phase2-input-row">
          <input
            value={note}
            placeholder="Capture a durable project memory"
            onChange={(event) => setNote(event.target.value)}
          />
          <button className="unified-btn send" type="button" disabled={!note.trim() || busy} onClick={() => void ingestNote()}>
            <Plus size={13} />
          </button>
        </div>
        <button className="phase2-wide-action" type="button" disabled={busy} onClick={() => void seedAutomation()}>
          <Workflow size={13} />
          <span>Queue digest workflow</span>
        </button>
      </section>
    </div>
  );
}

function DatabaseGlyph(): JSX.Element {
  return <BrainCircuit size={14} />;
}
