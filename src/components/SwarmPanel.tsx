import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BrainCircuit,
  Cpu,
  Database,
  GitBranch,
  Loader2,
  Network,
  RefreshCw,
  Route,
  Shield,
  Workflow,
} from "lucide-react";
import { apiClient } from "../engine/apiClient";
import { subscribeBrainBus } from "../engine/brainBus";
import type {
  SwarmEvent,
  SwarmHealth,
  SwarmNodeDescriptor,
  SwarmNodeType,
  SwarmSnapshot,
  SwarmTopologyEdge,
} from "../../shared/swarm";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function nodeTone(type: SwarmNodeType): string {
  switch (type) {
    case "memory":
      return "memory";
    case "execution":
      return "execution";
    case "reasoning":
    case "reflection":
      return "reasoning";
    case "simulation":
      return "simulation";
    case "observer":
      return "observer";
    case "tool":
      return "tool";
    case "ui":
      return "ui";
    case "context":
      return "context";
    case "evolution":
      return "evolution";
    case "organism":
      return "organism";
  }
}

function healthLabel(health: SwarmHealth): string {
  return health === "healthy" ? "ok" : health;
}

function eventLabel(event: SwarmEvent): string {
  switch (event.kind) {
    case "node-registered":
      return `${event.node.name} registered`;
    case "node-heartbeat":
      return `${event.nodeId} heartbeat`;
    case "task-queued":
      return `Queued ${event.task.goal}`;
    case "task-routed":
      return `${event.route.nodeName} accepted ${event.route.capability}`;
    case "task-completed":
      return `Completed ${event.task.goal}`;
    case "consensus-completed":
      return event.round.decision;
    case "policy-updated":
      return `Policy ${event.policy.operatingMode}`;
  }
}

function positionFor(index: number, total: number, node: SwarmNodeDescriptor): { x: number; y: number } {
  if (node.id === "brain-core-orchestrator") return { x: 50, y: 50 };
  const ringIndex = Math.max(0, index - 1);
  const ringTotal = Math.max(1, total - 1);
  const angle = (ringIndex / ringTotal) * Math.PI * 2 - Math.PI / 2;
  const radius = node.location === "cloud" || node.location === "remote" ? 41 : 34;
  return {
    x: 50 + Math.cos(angle) * radius,
    y: 50 + Math.sin(angle) * radius,
  };
}

function SwarmTopology({ nodes, edges }: { nodes: SwarmNodeDescriptor[]; edges: SwarmTopologyEdge[] }): JSX.Element {
  const visibleNodes = useMemo(() => nodes.slice(0, 14), [nodes]);
  const nodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    visibleNodes.forEach((node, index) => map.set(node.id, positionFor(index, visibleNodes.length, node)));
    return map;
  }, [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId)).slice(0, 36),
    [edges, nodeIds],
  );

  return (
    <div className="swarm-topology">
      <svg viewBox="0 0 100 100" role="img" aria-label="Swarm topology">
        {visibleEdges.map((edge) => {
          const from = positions.get(edge.fromId);
          const to = positions.get(edge.toId);
          if (!from || !to) return null;
          return (
            <line
              key={`${edge.fromId}-${edge.toId}-${edge.kind}`}
              className={edge.active ? "active" : ""}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              strokeWidth={Math.max(0.25, edge.weight)}
            />
          );
        })}
        {visibleNodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          return (
            <g key={node.id} transform={`translate(${pos.x} ${pos.y})`}>
              <circle
                className={`swarm-node-dot ${nodeTone(node.type)} ${node.health} ${
                  node.activeTasks.length > 0 ? "busy" : ""
                }`}
                r={node.id === "brain-core-orchestrator" ? 4.8 : 3.2}
              />
              <title>{`${node.name} - ${node.health}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="swarm-legend">
        <span>local</span>
        <span>worker</span>
        <span>remote/cloud gated</span>
      </div>
    </div>
  );
}

export function SwarmPanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<SwarmSnapshot | null>(null);
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await apiClient.swarm();
      setSnapshot(next);
      setEvents(next.recentEvents);
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
      if (message.type === "swarm-snapshot") {
        setSnapshot(message.snapshot);
        setEvents(message.snapshot.recentEvents);
      }
      if (message.type === "swarm-event") {
        setEvents((current) => [message.event, ...current.filter((event) => event !== message.event)].slice(0, 50));
      }
    });
  }, []);

  const routeWorkflow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.swarmRouteWorkflow({
        goal: "Fix Rust workspace",
        includeExecution: false,
        priority: 74,
        privacyMode: "local-first",
        payload: { source: "swarm-panel" },
      });
      setSnapshot(result.snapshot);
      setEvents(result.snapshot.recentEvents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const runConsensus = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.swarmConsensus({
        question: "Choose the safest local-first plan before execution",
      });
      setSnapshot(result.snapshot);
      setEvents(result.snapshot.recentEvents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const nodes = snapshot?.nodes ?? [];
  const tasks = snapshot?.tasks ?? [];
  const consensus = snapshot?.consensus ?? [];
  const healthy = nodes.filter((node) => node.health === "healthy").length;
  const active = nodes.reduce((sum, node) => sum + node.activeTasks.length, 0);
  const local = nodes.filter((node) => node.location === "local" || node.location === "worker").length;
  const gated = nodes.filter((node) => node.location === "remote" || node.location === "cloud").length;

  return (
    <div className="swarm-panel">
      <div className="phase2-toolbar">
        <div className="phase2-title">
          <Network size={15} />
          <span>Swarm</span>
        </div>
        <button className="unified-btn small" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      {error ? <div className="unified-error">{error}</div> : null}

      <div className="phase2-stat-grid">
        <div>
          <BrainCircuit size={14} />
          <strong>{nodes.length}</strong>
          <span>nodes</span>
        </div>
        <div>
          <Activity size={14} />
          <strong>{healthy}/{nodes.length || 0}</strong>
          <span>health</span>
        </div>
        <div>
          <Cpu size={14} />
          <strong>{active}</strong>
          <span>active</span>
        </div>
        <div>
          <Shield size={14} />
          <strong>{local}/{gated}</strong>
          <span>local/gated</span>
        </div>
      </div>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <GitBranch size={13} />
          <span>Topology</span>
        </div>
        <SwarmTopology nodes={nodes} edges={snapshot?.topology ?? []} />
      </section>

      <section className="phase2-section swarm-actions">
        <button className="phase2-wide-action" type="button" onClick={() => void routeWorkflow()} disabled={busy}>
          <Route size={13} />
          <span>Route Rust workspace fix</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void runConsensus()} disabled={busy}>
          <Workflow size={13} />
          <span>Run consensus</span>
        </button>
      </section>

      <section className="phase2-section phase2-two-col">
        <div>
          <div className="phase2-section-head">
            <Database size={13} />
            <span>Nodes</span>
          </div>
          <div className="swarm-node-list">
            {nodes.slice(0, 8).map((node) => (
              <div key={node.id} className={`swarm-node-card ${nodeTone(node.type)} ${node.health}`}>
                <div>
                  <strong>{node.name}</strong>
                  <span>{node.organ}</span>
                </div>
                <small>{`${node.location} / ${healthLabel(node.health)}`}</small>
                <div className="swarm-load">
                  <span style={{ width: pct(Math.max(node.resources.cpu, node.resources.ram)) }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="phase2-section-head">
            <Activity size={13} />
            <span>Tasks</span>
          </div>
          <div className="swarm-task-list">
            {tasks.slice(0, 6).map((task) => (
              <div key={task.id}>
                <strong>{task.goal}</strong>
                <span>{task.state}</span>
                <small>{task.trace[0]?.nodeName ?? "unassigned"}</small>
              </div>
            ))}
            {tasks.length === 0 ? <small className="phase2-muted">No swarm tasks</small> : null}
          </div>
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <BrainCircuit size={13} />
          <span>Consensus</span>
        </div>
        <div className="swarm-consensus">
          {consensus.slice(0, 3).map((round) => (
            <div key={round.id}>
              <strong>{round.decision}</strong>
              <span>{`${pct(round.confidence)} confidence / ${pct(round.risk)} risk`}</span>
            </div>
          ))}
          {consensus.length === 0 ? <small className="phase2-muted">No consensus rounds</small> : null}
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Activity size={13} />
          <span>Event Stream</span>
        </div>
        <div className="swarm-event-list">
          {events.slice(0, 8).map((event) => (
            <div key={`${event.kind}-${event.at}`}>
              <span>{event.kind}</span>
              <strong>{eventLabel(event)}</strong>
              <small>{shortTime(event.at)}</small>
            </div>
          ))}
          {events.length === 0 ? <small className="phase2-muted">No swarm events</small> : null}
        </div>
      </section>
    </div>
  );
}
