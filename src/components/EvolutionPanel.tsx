import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BrainCircuit,
  Database,
  GitBranch,
  Loader2,
  RefreshCw,
  Shield,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";
import { apiClient } from "../engine/apiClient";
import { subscribeBrainBus } from "../engine/brainBus";
import type {
  CognitiveFitnessMetrics,
  EvolutionComponent,
  EvolutionComponentKind,
  EvolutionSnapshot,
} from "../../shared/evolution";

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

function kindClass(kind: EvolutionComponentKind): string {
  return kind.replace(/[^a-z0-9-]/g, "");
}

const METRIC_ROWS: Array<[keyof Omit<CognitiveFitnessMetrics, "overall">, string]> = [
  ["successRate", "success"],
  ["predictionAccuracy", "prediction"],
  ["planningEfficiency", "planning"],
  ["memoryQuality", "memory"],
  ["safetyScore", "safety"],
  ["latencyScore", "latency"],
];

function EvolutionMap({ components }: { components: EvolutionComponent[] }): JSX.Element {
  const visible = useMemo(() => components.slice(0, 18), [components]);
  const kinds = useMemo(() => Array.from(new Set(visible.map((component) => component.kind))), [visible]);
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    visible.forEach((component, index) => {
      const kindIndex = Math.max(0, kinds.indexOf(component.kind));
      const kindTotal = Math.max(1, kinds.length - 1);
      const x = 10 + (kindIndex / kindTotal) * 80 + (index % 2) * 2.5;
      const y = 88 - component.metrics.overall * 68;
      map.set(component.id, { x, y });
    });
    return map;
  }, [kinds, visible]);

  return (
    <div className="evolution-map">
      <svg viewBox="0 0 100 100" role="img" aria-label="Cognitive evolution map">
        {visible.map((component) => {
          const from = component.parentId ? positions.get(component.parentId) : null;
          const to = positions.get(component.id);
          if (!from || !to) return null;
          return (
            <line
              key={`${component.parentId}-${component.id}`}
              className="mutation-line"
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
            />
          );
        })}
        {visible.map((component) => {
          const pos = positions.get(component.id);
          if (!pos) return null;
          return (
            <g key={component.id} transform={`translate(${pos.x} ${pos.y})`}>
              <circle
                className={`evolution-dot ${kindClass(component.kind)} ${component.status}`}
                r={component.preferred ? 4.3 : 3.2}
              />
              <title>{`${component.name} ${pct(component.metrics.overall)}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="evolution-map-meta">
        <span>{components.length} components</span>
        <span>{kinds.length} regions</span>
      </div>
    </div>
  );
}

function FitnessBars({ metrics }: { metrics: CognitiveFitnessMetrics }): JSX.Element {
  return (
    <div className="evolution-fitness">
      {METRIC_ROWS.map(([key, name]) => (
        <div key={key}>
          <span>{name}</span>
          <div>
            <i style={{ width: pct(metrics[key]) }} />
          </div>
          <strong>{pct(metrics[key])}</strong>
        </div>
      ))}
    </div>
  );
}

export function EvolutionPanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<EvolutionSnapshot | null>(null);
  const [goal, setGoal] = useState("Fix my Rust workspace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await apiClient.evolution();
      setSnapshot(next);
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
      if (message.type === "evolution-snapshot") {
        setSnapshot(message.snapshot);
      }
      if (
        message.type === "evolution-mutation" ||
        message.type === "evolution-experiment" ||
        message.type === "evolution-trait"
      ) {
        void refresh();
      }
    });
  }, [refresh]);

  const evaluate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.evolutionEvaluate();
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const mutateWorkflow = useCallback(async () => {
    const text = goal.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.evolutionMutateWorkflow({ goal: text });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [goal]);

  const evolveSkill = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.evolutionEvolveSkill({
        goal,
        sourceSkills: ["Rust Build Skill", "Debugging Skill", "Memory Recall Skill"],
      });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [goal]);

  const benchmark = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.evolutionBenchmarkStrategies({ goal });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [goal]);

  const experiment = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.evolutionExperiment({
        targetKind: "memory-model",
        hypothesis: "Adaptive memory queries can improve retrieval quality without lowering safety.",
      });
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const identity = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.evolutionIdentity();
      setSnapshot(result.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const components = snapshot?.components ?? [];
  const mutations = snapshot?.mutations ?? [];
  const experiments = snapshot?.experiments ?? [];
  const traits = snapshot?.identityTraits ?? [];
  const strategies = components.filter((component) => component.kind === "reasoning-strategy").slice(0, 6);
  const metrics = snapshot?.fitness ?? {
    successRate: 0,
    latencyScore: 0,
    reliability: 0,
    predictionAccuracy: 0,
    memoryQuality: 0,
    planningEfficiency: 0,
    safetyScore: 0,
    userSatisfaction: 0,
    costScore: 0,
    overall: 0,
  };
  const approved = components.filter((component) => component.status === "approved" || component.status === "applied").length;
  const sandboxed = components.filter((component) => component.status === "sandboxed" || component.status === "benchmarked").length;

  return (
    <div className="evolution-panel">
      <div className="phase2-toolbar">
        <div className="phase2-title">
          <Zap size={15} />
          <span>Evolution</span>
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
            if (event.key === "Enter") void mutateWorkflow();
          }}
          placeholder="Evolution target"
        />
        <button className="unified-btn send" type="button" onClick={() => void mutateWorkflow()} disabled={!goal.trim() || busy}>
          <GitBranch size={13} />
        </button>
      </div>

      <div className="phase2-stat-grid">
        <div>
          <Activity size={14} />
          <strong>{pct(metrics.overall)}</strong>
          <span>fitness</span>
        </div>
        <div>
          <BrainCircuit size={14} />
          <strong>{components.length}</strong>
          <span>genomes</span>
        </div>
        <div>
          <Shield size={14} />
          <strong>{approved}/{sandboxed}</strong>
          <span>stable/sandbox</span>
        </div>
        <div>
          <Sparkles size={14} />
          <strong>{traits.length}</strong>
          <span>traits</span>
        </div>
      </div>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <GitBranch size={13} />
          <span>Cognitive Genome Map</span>
        </div>
        <EvolutionMap components={components} />
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Activity size={13} />
          <span>Fitness Scores</span>
        </div>
        <FitnessBars metrics={metrics} />
      </section>

      <section className="phase2-section evolution-actions">
        <button className="phase2-wide-action" type="button" onClick={() => void evaluate()} disabled={busy}>
          <Activity size={13} />
          <span>Evaluate</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void benchmark()} disabled={busy}>
          <BrainCircuit size={13} />
          <span>Benchmark</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void evolveSkill()} disabled={busy}>
          <Workflow size={13} />
          <span>Evolve Skill</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void experiment()} disabled={busy}>
          <Database size={13} />
          <span>Experiment</span>
        </button>
        <button className="phase2-wide-action" type="button" onClick={() => void identity()} disabled={busy}>
          <Sparkles size={13} />
          <span>Identity</span>
        </button>
      </section>

      <section className="phase2-section phase2-two-col">
        <div>
          <div className="phase2-section-head">
            <BrainCircuit size={13} />
            <span>Strategies</span>
          </div>
          <div className="evolution-component-list">
            {strategies.map((strategy) => (
              <div key={strategy.id} className={`evolution-component ${strategy.preferred ? "preferred" : ""}`}>
                <div>
                  <strong>{strategy.name}</strong>
                  <span>{strategy.status}</span>
                </div>
                <small>{`${pct(strategy.metrics.overall)} fitness / v${strategy.version}`}</small>
              </div>
            ))}
            {strategies.length === 0 ? <small className="phase2-muted">No strategy benchmarks</small> : null}
          </div>
        </div>
        <div>
          <div className="phase2-section-head">
            <Shield size={13} />
            <span>Traits</span>
          </div>
          <div className="evolution-trait-list">
            {traits.slice(0, 5).map((trait) => (
              <div key={trait.id}>
                <strong>{trait.trait}</strong>
                <span>{`${pct(trait.confidence)} confidence`}</span>
              </div>
            ))}
            {traits.length === 0 ? <small className="phase2-muted">No persistent traits</small> : null}
          </div>
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Workflow size={13} />
          <span>Mutations</span>
        </div>
        <div className="evolution-mutation-list">
          {mutations.slice(0, 5).map((mutation) => (
            <div key={mutation.id}>
              <span>{label(mutation.kind)}</span>
              <strong>{`${pct(mutation.benchmark.candidateFitness)} candidate / ${pct(mutation.benchmark.stability)} stable`}</strong>
              <small>{mutation.requiresApproval ? "approval required" : mutation.status}</small>
            </div>
          ))}
          {mutations.length === 0 ? <small className="phase2-muted">No sandboxed mutations</small> : null}
        </div>
      </section>

      <section className="phase2-section">
        <div className="phase2-section-head">
          <Database size={13} />
          <span>Experiments</span>
        </div>
        <div className="evolution-experiment-list">
          {experiments.slice(0, 4).map((item) => (
            <div key={item.id}>
              <strong>{item.name}</strong>
              <span>{`${label(item.targetKind)} / +${item.fitnessDelta.toFixed(3)}`}</span>
              <small>{shortTime(item.createdAt)}</small>
            </div>
          ))}
          {experiments.length === 0 ? <small className="phase2-muted">No idle experiments</small> : null}
        </div>
      </section>
    </div>
  );
}
