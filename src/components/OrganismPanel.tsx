import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Brain,
  Database,
  GitBranch,
  HeartPulse,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";
import { apiClient } from "../engine/apiClient";
import { subscribeBrainBus } from "../engine/brainBus";
import type {
  CognitiveHealth,
  MemoryStratum,
  OrganismSnapshot,
  PersistentGoal,
  WorldModel,
} from "../../shared/organism";

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function label(value: string): string {
  return value.replace(/-/g, " ");
}

function OrganismMap({ snapshot }: { snapshot: OrganismSnapshot | null }): JSX.Element {
  const goals = snapshot?.goals.slice(0, 5) ?? [];
  const subBrains = snapshot?.subBrains.slice(0, 5) ?? [];
  const health = snapshot?.health.healthScore ?? 0;
  const energy = snapshot?.state.energy.current ?? 0;
  const nodes = useMemo(() => {
    const base = [{ id: "core", label: "core", x: 50, y: 50, tone: "core", size: 6 }];
    goals.forEach((goal, index) => {
      const angle = (index / Math.max(1, goals.length)) * Math.PI * 2 - Math.PI / 2;
      base.push({
        id: goal.id,
        label: goal.title,
        x: 50 + Math.cos(angle) * 29,
        y: 50 + Math.sin(angle) * 29,
        tone: goal.status,
        size: 3.2 + goal.progress * 2.2,
      });
    });
    subBrains.forEach((subBrain, index) => {
      const angle = (index / Math.max(1, subBrains.length)) * Math.PI * 2 + Math.PI / 5;
      base.push({
        id: subBrain.id,
        label: subBrain.name,
        x: 50 + Math.cos(angle) * 41,
        y: 50 + Math.sin(angle) * 41,
        tone: "subbrain",
        size: 3 + subBrain.maturity * 2,
      });
    });
    return base;
  }, [goals, subBrains]);

  return (
    <div className="organism-map">
      <svg viewBox="0 0 100 100" role="img" aria-label="Persistent organism topology">
        <circle className="organism-field health" cx="50" cy="50" r={24 + health * 16} />
        <circle className="organism-field energy" cx="50" cy="50" r={18 + energy * 0.22} />
        {nodes
          .filter((node) => node.id !== "core")
          .map((node) => (
            <line key={`line-${node.id}`} x1="50" y1="50" x2={node.x} y2={node.y} />
          ))}
        {nodes.map((node) => (
          <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
            <circle className={`organism-node ${node.tone}`} r={node.size} />
            <title>{node.label}</title>
          </g>
        ))}
      </svg>
      <div className="organism-map-meta">
        <span>{snapshot?.state.lifecycle ?? "booting"}</span>
        <span>{snapshot ? `${Math.round(snapshot.state.energy.current)}/${snapshot.state.energy.capacity}` : "0/0"} energy</span>
      </div>
    </div>
  );
}

function HealthBars({ health }: { health: CognitiveHealth }): JSX.Element {
  const rows: Array<[string, number]> = [
    ["memory", health.memoryIntegrity],
    ["workflow", health.workflowStability],
    ["identity", health.identityCoherence],
    ["goals", health.goalAlignment],
    ["resource", health.resourceBalance],
    ["immune", 1 - health.immuneLoad],
  ];
  return (
    <div className="organism-health-bars">
      {rows.map(([name, value]) => (
        <div key={name}>
          <span>{name}</span>
          <div><i style={{ width: pct(value) }} /></div>
          <strong>{pct(value)}</strong>
        </div>
      ))}
    </div>
  );
}

function GoalList({ goals, onProgress }: { goals: PersistentGoal[]; onProgress: (goal: PersistentGoal) => void }): JSX.Element {
  return (
    <div className="organism-goal-list">
      {goals.slice(0, 6).map((goal) => (
        <button key={goal.id} type="button" onClick={() => onProgress(goal)}>
          <div>
            <strong>{goal.title}</strong>
            <span>{goal.status}</span>
          </div>
          <div className="organism-progress"><i style={{ width: pct(goal.progress) }} /></div>
          <small>{`${pct(goal.progress)} / ${pct(goal.confidence)} confidence`}</small>
        </button>
      ))}
      {goals.length === 0 ? <small className="phase2-muted">No persistent goals</small> : null}
    </div>
  );
}

function WorldModelView({ world }: { world: WorldModel }): JSX.Element {
  const lines = [
    ...world.userHabits.slice(0, 3),
    ...world.workflowPatterns.slice(0, 3),
    ...world.historicalTrends.slice(0, 2),
  ];
  return (
    <div className="organism-world">
      <strong>{world.summary}</strong>
      {lines.map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}

function MemoryStrata({ strata }: { strata: MemoryStratum[] }): JSX.Element {
  const max = Math.max(1, ...strata.map((item) => item.count));
  return (
    <div className="organism-strata">
      {strata.map((item) => (
        <div key={item.timescale}>
          <span>{label(item.timescale)}</span>
          <div><i style={{ width: `${Math.max(5, (item.count / max) * 100)}%` }} /></div>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

export function OrganismPanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<OrganismSnapshot | null>(null);
  const [goalTitle, setGoalTitle] = useState("Improve persistent organism continuity");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await apiClient.organism());
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
      if (message.type === "organism-snapshot") setSnapshot(message.snapshot);
      if (message.type === "organism-immune-event" || message.type === "organism-lifecycle") void refresh();
    });
  }, [refresh]);

  const wake = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.organismWake();
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const createGoal = useCallback(async () => {
    const title = goalTitle.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.organismCreateGoal({
        title,
        priority: 78,
        subgoals: ["preserve continuity", "maintain health", "track identity drift"],
        confidence: 0.64,
      });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [goalTitle]);

  const progressGoal = useCallback(async (goal: PersistentGoal) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.organismUpdateGoal({
        goalId: goal.id,
        progress: Math.min(1, goal.progress + 0.08),
        status: goal.progress >= 0.92 ? "completed" : goal.status,
        attempt: {
          summary: "Manual progress pulse from organism dashboard.",
          outcome: "partial",
        },
      });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const maintenance = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.organismMaintenance();
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const dream = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.organismDream();
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const research = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.organismResearch({
        title: "Continuity-preserving cognition research",
        hypothesis: "Persistent state snapshots can improve reboot recovery without increasing unsafe autonomy.",
      });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const subBrain = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.organismCreateSubBrain({
        name: "Rust Continuity Node",
        specialization: "Long-running Rust workspace repair, dependency memory, and targeted validation",
        inheritedMemoryScopes: ["Rust", "cargo", "workspace repair"],
        inheritedSkills: ["simulation-first planning", "local-first repair workflow"],
      });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const state = snapshot?.state;
  const health = snapshot?.health;
  const energy = state?.energy;
  const goals = snapshot?.goals ?? [];
  const activeGoals = goals.filter((goal) => goal.status === "active" || goal.status === "blocked");
  const immune = snapshot?.immuneEvents ?? [];
  const dreams = snapshot?.dreamCycles ?? [];
  const researchSessions = snapshot?.researchSessions ?? [];

  return (
    <div className="organism-panel">
      <div className="phase2-toolbar">
        <div className="phase2-title">
          <HeartPulse size={15} />
          <span>Organism</span>
        </div>
        <button className="unified-btn small" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      {error ? <div className="unified-error">{error}</div> : null}

      <div className="phase2-input-row">
        <input
          value={goalTitle}
          onChange={(event) => setGoalTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void createGoal();
          }}
          placeholder="Persistent goal"
        />
        <button className="unified-btn send" type="button" onClick={() => void createGoal()} disabled={!goalTitle.trim() || busy}>
          <Plus size={13} />
        </button>
      </div>

      <div className="phase2-stat-grid">
        <div>
          <HeartPulse size={14} />
          <strong>{health ? pct(health.healthScore) : "0%"}</strong>
          <span>health</span>
        </div>
        <div>
          <Zap size={14} />
          <strong>{energy ? Math.round(energy.current) : 0}</strong>
          <span>energy</span>
        </div>
        <div>
          <GitBranch size={14} />
          <strong>{activeGoals.length}</strong>
          <span>goals</span>
        </div>
        <div>
          <Shield size={14} />
          <strong>{immune.length}</strong>
          <span>immune</span>
        </div>
      </div>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Brain size={13} />
          <span>Living Topology</span>
        </div>
        <OrganismMap snapshot={snapshot} />
      </section>

      {health ? (
        <section className="phase2-section">
          <div className="phase2-section-head">
            <Activity size={13} />
            <span>Homeostasis</span>
          </div>
          <HealthBars health={health} />
        </section>
      ) : null}

      <section className="phase2-section organism-actions">
        <button className="phase2-wide-action" type="button" onClick={() => void wake()} disabled={busy}>
          <Sparkles size={13} />
          <span>Wake</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void maintenance()} disabled={busy}>
          <Shield size={13} />
          <span>Maintain</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void dream()} disabled={busy}>
          <Moon size={13} />
          <span>Dream</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void research()} disabled={busy}>
          <Database size={13} />
          <span>Research</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void subBrain()} disabled={busy}>
          <Brain size={13} />
          <span>Sub-brain</span>
        </button>
      </section>

      <section className="phase2-section phase2-two-col">
        <div>
          <div className="phase2-section-head">
            <GitBranch size={13} />
            <span>Goals</span>
          </div>
          <GoalList goals={goals} onProgress={progressGoal} />
        </div>
        <div>
          <div className="phase2-section-head">
            <Database size={13} />
            <span>World Model</span>
          </div>
          {snapshot ? <WorldModelView world={snapshot.worldModel} /> : <small className="phase2-muted">No world model</small>}
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Database size={13} />
          <span>Multi-timescale Memory</span>
        </div>
        <MemoryStrata strata={snapshot?.memoryStrata ?? []} />
      </section>

      <section className="phase2-section phase2-two-col">
        <div>
          <div className="phase2-section-head">
            <Shield size={13} />
            <span>Immune Events</span>
          </div>
          <div className="organism-event-list">
            {immune.slice(0, 5).map((event) => (
              <div key={event.id} className={event.severity}>
                <span>{label(event.kind)}</span>
                <strong>{event.detail}</strong>
                <small>{`${event.status} / ${shortTime(event.createdAt)}`}</small>
              </div>
            ))}
            {immune.length === 0 ? <small className="phase2-muted">No immune events</small> : null}
          </div>
        </div>
        <div>
          <div className="phase2-section-head">
            <Moon size={13} />
            <span>Dream / Research</span>
          </div>
          <div className="organism-event-list">
            {dreams.slice(0, 2).map((item) => (
              <div key={item.id}>
                <span>{item.status}</span>
                <strong>{item.outputs[0] ?? "dream cycle"}</strong>
                <small>{shortTime(item.startedAt)}</small>
              </div>
            ))}
            {researchSessions.slice(0, 2).map((item) => (
              <div key={item.id}>
                <span>research</span>
                <strong>{item.title}</strong>
                <small>{`${pct(item.risk)} risk`}</small>
              </div>
            ))}
            {dreams.length === 0 && researchSessions.length === 0 ? (
              <small className="phase2-muted">No dream or research sessions</small>
            ) : null}
          </div>
        </div>
      </section>

      {snapshot?.subBrains.length ? (
        <section className="phase2-section">
          <div className="phase2-section-head">
            <Brain size={13} />
            <span>Specialized Sub-brains</span>
          </div>
          <div className="organism-subbrain-list">
            {snapshot.subBrains.slice(0, 4).map((item) => (
              <div key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.specialization}</span>
                <small>{pct(item.maturity)} maturity</small>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
