// BrainCore — boots the agentic layer and bridges its internal nervous system
// to the browser.
//
// This is the ONLY module that couples the agent layer to the WS hub + DB,
// which is what keeps core/eventBus.ts pure enough for the offline self-check.
// The bridge maps internal BrainEvents onto the existing `BrainBusMessage`
// wire shape so current frontend consumers (brainBus.ts, StatusBar, the pet)
// receive them with no protocol change.

import type { BrainBusMessage } from "../../../shared/pipeline.js";
import { clampMagnitude, regionsFor, type CognitionEvent } from "../../../shared/cognition.js";
import { getEventBus, nowIso, type BrainEvent } from "../core/eventBus.js";
import { gatherCuriosity } from "../core/curiosity.js";
import { createCognitiveEvolutionEngine } from "../core/evolution.js";
import { createImaginationEngine } from "../core/imagination.js";
import { createPersistentOrganism } from "../core/organism.js";
import { createGoalManager } from "../core/goalManager.js";
import { createBrainState } from "../core/brainState.js";
import { getKernel } from "../core/kernel.js";
import { currentStage, stageAllows } from "../core/stages.js";
import { getBeliefEngine } from "../core/beliefs.js";
import { listProcedures } from "../memory/procedural.js";
import { getSpine } from "../spine/cord.js";
import { autoPursuitTick, notePursuitActivity } from "../reasoning/goalPursuit.js";
import { getMcpHub } from "../mcp/hub.js";
import { runWorkspaceCycle, requestWorkspaceCycle } from "../core/workspace.js";
import { runCreativeCycle, creativityStats } from "../core/creativity.js";
import { getHypothesisEngine } from "../core/hypotheses.js";
import { emitMonologue } from "../core/monologue.js";
import { getNarrative } from "../core/narrative.js";
import { getCognitiveDna } from "../core/cognitiveDna.js";
import { emotionStatus } from "../core/emotions.js";
import { getSelfRepresentation } from "../core/selfRepresentation.js";
import { CONFIG } from "../config.js";
import { createSafetyGate } from "../core/safety.js";
import { createCognitiveSwarm } from "../core/swarm.js";
import { initSelfConsciousness } from "../core/selfConsciousness.js";
import { broadcast } from "../ws/brainBus.js";
import { getMemoryCount } from "../db/repositories/memory.js";
import { getNeuromodulators } from "../core/neuromodulators.js";
import { getDiagnosticCounts } from "../util/diagnostics.js";
import { recordVitals, pruneOldTelemetry } from "../observability/vitals.js";
import { snapshot as metricsSnapshot } from "../observability/metrics.js";
import { isFeatureActive } from "../core/maturation.js";
import { AgentRuntime } from "./runtime.js";
import { ObserverAgent } from "./observerAgent.js";
import { SummaryAgent } from "./summaryAgent.js";
import { SchedulerAgent } from "./schedulerAgent.js";
import { SystemSensorAgent } from "./systemSensorAgent.js";
import { IdleAgent } from "./idleAgent.js";

// Runtime cadence. 60s keeps the LLM-backed SummaryAgent from running hotter
// than the 4s observer burst window — activity accumulates, then one rollup.
const AGENT_CYCLE_MS = 60_000;

function toWireMessage(event: BrainEvent): BrainBusMessage | null {
  switch (event.kind) {
    case "file-changed":
      return {
        type: "file-changed",
        path: event.path,
        change: event.change,
        projectName: event.projectName,
        timestamp: event.at,
      };
    case "activity-observed":
      return {
        type: "activity-observed",
        projectName: event.projectName,
        fileCount: event.files.length,
        detail: `${event.files.length} file(s) changed in ${event.projectName}`,
        timestamp: event.at,
      };
    case "summary-created":
      return {
        type: "summary-created",
        memoryId: event.memoryId,
        projectName: event.projectName,
        summary: event.summary,
        timestamp: event.at,
      };
    case "agent-status":
      return {
        type: "agent-status",
        agent: event.agent,
        state: event.state,
        detail: event.detail,
        timestamp: event.at,
      };
    case "twin-snapshot":
      return {
        type: "twin-snapshot",
        snapshot: event.snapshot,
        timestamp: event.at,
      };
    case "twin-anomaly":
      return {
        type: "twin-anomaly",
        anomaly: event.anomaly,
        timestamp: event.at,
      };
    case "swarm-event":
      return {
        type: "swarm-event",
        event: event.event,
        timestamp: event.at,
      };
    case "swarm-snapshot":
      return {
        type: "swarm-snapshot",
        snapshot: event.snapshot,
        timestamp: event.at,
      };
    case "imagination-session":
      return {
        type: "imagination-session",
        session: event.session,
        timestamp: event.at,
      };
    case "imagination-reflection":
      return {
        type: "imagination-reflection",
        reflection: event.reflection,
        timestamp: event.at,
      };
    case "imagination-dream":
      return {
        type: "imagination-dream",
        abstractions: event.abstractions,
        timestamp: event.at,
      };
    case "imagination-snapshot":
      return {
        type: "imagination-snapshot",
        snapshot: event.snapshot,
        timestamp: event.at,
      };
    case "evolution-snapshot":
      return {
        type: "evolution-snapshot",
        snapshot: event.snapshot,
        timestamp: event.at,
      };
    case "evolution-mutation":
      return {
        type: "evolution-mutation",
        mutation: event.mutation,
        timestamp: event.at,
      };
    case "evolution-experiment":
      return {
        type: "evolution-experiment",
        experiment: event.experiment,
        timestamp: event.at,
      };
    case "evolution-trait":
      return {
        type: "evolution-trait",
        trait: event.trait,
        timestamp: event.at,
      };
    case "organism-snapshot":
      return {
        type: "organism-snapshot",
        snapshot: event.snapshot,
        timestamp: event.at,
      };
    case "organism-lifecycle":
      return {
        type: "organism-lifecycle",
        lifecycle: event.lifecycle,
        reason: event.reason,
        timestamp: event.at,
      };
    case "organism-immune-event":
      return {
        type: "organism-immune-event",
        event: event.event,
        timestamp: event.at,
      };
    case "idle-thought":
      return {
        type: "idle-thought",
        memoryId: event.memoryId,
        preview: event.preview,
        importance: event.importance,
        reason: event.reason,
        timestamp: event.at,
      };
    case "exploration-scheduled":
      return {
        type: "exploration-scheduled",
        target: event.target,
        curiosity: event.curiosity,
        reason: event.reason,
        timestamp: event.at,
      };
    case "brain-state":
      return {
        type: "brain-state",
        snapshot: event.snapshot,
        timestamp: event.at,
      };
    case "self-snapshot":
      return {
        type: "self-snapshot",
        state: event.state,
        timestamp: event.at,
      };
    case "cognition":
      return {
        type: "cognition",
        event: event.event,
        timestamp: event.at,
      };
  }
}

// ── Internal monologue unification ──────────────────────────────────────────
// The brain already THINKS in several places — workspace micro-thoughts and
// idle sampling (`idle-thought`), curiosity (`exploration-scheduled`),
// imagination reflections/dreams, and selfConsciousness monologues (inside
// `self-snapshot`). Rather than a fourth thought engine, this PURE mapping
// synthesizes one `cognition` event from each legacy thought event at the one
// point they all already pass through (the bridge below), so the browser sees
// a single continuous inner-life stream. `lastMonologueAt` threads the dedup
// state for `self-snapshot` (which re-emits its whole state constantly).
export function toCognition(
  event: BrainEvent,
  lastMonologueAt?: string,
): CognitionEvent | null {
  switch (event.kind) {
    case "idle-thought":
      return {
        kind: "thought",
        label: event.preview,
        magnitude: clampMagnitude(event.importance),
        logicalRegions: regionsFor("thought"),
        reason: event.reason,
        at: event.at,
      };
    case "exploration-scheduled":
      return {
        kind: "curiosity-spike",
        label: `Curious about: ${event.target}`,
        magnitude: clampMagnitude(event.curiosity),
        logicalRegions: regionsFor("curiosity-spike"),
        reason: event.reason,
        at: event.at,
      };
    case "imagination-reflection":
      return {
        kind: "reflection",
        label: event.reflection.lesson || `Reflected on: ${event.reflection.actualSummary}`,
        detail: `prediction accuracy ${(event.reflection.accuracy * 100).toFixed(0)}%`,
        magnitude: clampMagnitude(1 - event.reflection.accuracy),
        logicalRegions: regionsFor("reflection"),
        reason: "imagination:reflection",
        at: event.at,
      };
    case "imagination-dream":
      return {
        kind: "dream",
        label: `Dreamed ${event.abstractions.length} abstraction(s)`,
        detail: event.abstractions[0]?.concept,
        magnitude: clampMagnitude(0.3 + 0.1 * event.abstractions.length),
        logicalRegions: regionsFor("dream"),
        reason: "imagination:dream",
        at: event.at,
      };
    case "self-snapshot": {
      const m = event.state.recentMonologues[0];
      if (!m) return null;
      // Dedup: self-snapshot re-emits constantly; only a NEW monologue counts.
      if (lastMonologueAt && m.timestamp <= lastMonologueAt) return null;
      return {
        kind: "monologue",
        label: m.content,
        detail: m.kind,
        magnitude: clampMagnitude(m.confidence),
        logicalRegions: regionsFor("monologue"),
        reason: `self-consciousness:${m.trigger}`,
        at: m.timestamp,
      };
    }
    default:
      return null;
  }
}

export interface BrainCoreHandle {
  shutdown(): Promise<void>;
}

export async function startBrainCore(): Promise<BrainCoreHandle> {
  const bus = getEventBus();

  // Monologue-dedup watermark for toCognition's self-snapshot mapping.
  let lastMonologueAt = "";
  const unbridge = bus.onAny((event) => {
    const message = toWireMessage(event);
    if (message) broadcast(message);
    // Unified inner-monologue stream: synthesize a `cognition` frame from the
    // legacy thought events so every thought producer feeds ONE stream.
    if (event.kind !== "cognition") {
      const cog = toCognition(event, lastMonologueAt);
      if (cog) {
        if (cog.kind === "monologue") lastMonologueAt = cog.at;
        broadcast({ type: "cognition", event: cog, timestamp: cog.at });
      }
    }
    // A1 — real-work events reset the goal-pursuit quiet clock (the same
    // activity kinds the IdleAgent treats as "the system is busy").
    if (event.kind === "file-changed" || event.kind === "activity-observed" || event.kind === "summary-created") {
      notePursuitActivity();
    }
    // A new summary changes the memory count the StatusBar shows; refresh it.
    if (event.kind === "summary-created") {
      try {
        broadcast({ type: "memory-count", count: getMemoryCount() });
      } catch {
        /* non-fatal */
      }
    }
  });
  const swarm = createCognitiveSwarm(bus);
  const unswarm = bus.onAny((event) => swarm.observeBrainEvent(event));
  const stopSwarmHeartbeat = swarm.startHeartbeat();
  swarm.emitSnapshot();
  const imagination = createImaginationEngine(bus);
  const stopDreaming = imagination.startDreaming();
  bus.emit({ kind: "imagination-snapshot", snapshot: imagination.snapshot(), at: new Date().toISOString() });
  const evolution = createCognitiveEvolutionEngine(bus);
  const unevolution = bus.onAny((event) => evolution.observeBrainEvent(event));
  // The background evolution loop + an eager boot evaluate/benchmark are gated
  // behind CONFIG.enableEvolutionLoop (default OFF). The engine + its event
  // subscription + the snapshot stay unconditional so the /api/evolution/*
  // on-demand routes, the kernel status probe, and shutdown (unevolution) keep
  // working; only stopEvolutionLoop needs the ?. guard in shutdown below.
  let stopEvolutionLoop: (() => void) | undefined;
  // Unified resolver: the autonomous evolution loop runs when its static flag is
  // set OR the brain has grown into self-improvement (H2, stage ≥ 9), and isn't
  // resting (H1). With MATURATION + ENERGY_BUDGET off this is exactly
  // `CONFIG.enableEvolutionLoop` — no behavior change on the default brain.
  if (isFeatureActive("evolution-loop")) {
    stopEvolutionLoop = evolution.startEvolutionLoop();
    evolution.evaluate();
    evolution.benchmarkStrategies({ goal: "local-first predictive cognitive architecture" });
  }
  bus.emit({ kind: "evolution-snapshot", snapshot: evolution.snapshot(), at: new Date().toISOString() });
  const organism = createPersistentOrganism(bus);
  const unorganism = bus.onAny((event) => organism.observeBrainEvent(event));
  const stopOrganismAutonomy = organism.startAutonomy();
  organism.wake();

  // Goal manager — activates the goal HIERARCHY over the organism's persisted
  // goals and grows it from curiosity (`exploration-scheduled`) and high-
  // divergence reflections. Subscriptions are failure-isolated by the bus.
  const goalManager = createGoalManager(bus, organism);

  // Central cognitive loop. Created on the same process bus so its throttled
  // `brain-state` events fan out through the bridge above. The decay heartbeat
  // is autonomous thought: it ages the working-memory workspace so stale items
  // fade between queries. Failure-isolated — a tick error must never crash boot.
  const brainState = createBrainState(bus);
  const BRAIN_STATE_TICK_MS = 60_000;
  const brainStateTick = setInterval(() => {
    try {
      brainState.tickDecay(BRAIN_STATE_TICK_MS);
    } catch (err) {
      console.warn("[brain-core] brain-state decay tick failed:", err);
    }
  }, BRAIN_STATE_TICK_MS);
  if (typeof brainStateTick.unref === "function") brainStateTick.unref();

  // Global workspace — directed cognition between queries. Every interval the
  // bidders (open questions, curiosity, goals) compete and the winner gets one
  // LLM micro-thought, written back as memory + broadcast as an idle-thought.
  // Skips quietly when no connector / no bids; failures never crash the core.
  let workspaceTick: NodeJS.Timeout | null = null;
  if (CONFIG.workspaceEnabled || CONFIG.innerMonologue || CONFIG.creativityEnabled) {
    workspaceTick = setInterval(() => {
      if (CONFIG.workspaceEnabled) {
        void runWorkspaceCycle().catch((err) =>
          console.warn("[brain-core] workspace cycle failed:", err),
        );
      }
      // Creativity — bridge two distant memories into a novel idea on the same
      // cadence (reuses this timer, no new schedule). Failure-isolated. The
      // gate is the unified resolver: ON when the static flag is set OR the brain
      // has GROWN into it (H2, stage ≥ 5), AND it isn't resting an expensive
      // cycle while energy-depleted (H1). With both MATURATION and ENERGY_BUDGET
      // off this is exactly `CONFIG.creativityEnabled`.
      if (isFeatureActive("creativity")) {
        void runCreativeCycle().catch((err) =>
          console.warn("[brain-core] creative cycle failed:", err),
        );
      }
      // MYTHOS M2 — author one first-person monologue line into the cognition
      // stream on the workspace cadence ("I wonder… / I'm working toward… / I
      // keep turning over the belief that…"). Internally rate-limited; the
      // composer draws on the current stage, a contested belief, an active goal,
      // and the self-narrative identity. Never throws.
      if (CONFIG.innerMonologue) {
        try {
          const contested = getBeliefEngine().reExaminationCandidates(1)[0]?.statement ?? null;
          emitMonologue({
            stage: currentStage(),
            contestedBelief: contested,
            activeGoal: organism.getActiveGoalTitles(1)[0] ?? null,
            narrativeIdentity: getNarrative()?.identity ?? null,
          });
        } catch (err) {
          console.warn("[brain-core] inner monologue failed:", err);
        }
      }
    }, CONFIG.workspaceIntervalMin * 60_000);
    if (typeof workspaceTick.unref === "function") workspaceTick.unref();
  }

  // Self-Consciousness engine — observes internal events and builds a
  // persistent self-model. Reactive only (no autonomous tick), so no
  // memory/performance overhead when idle. Each handler is failure-isolated.
  const selfConsciousness = initSelfConsciousness(bus);
  const unselfLifecycle = bus.on("organism-lifecycle", (e) => {
    selfConsciousness.react({ type: "goal_change", payload: { title: e.lifecycle, activeGoals: 0 } });
    bus.emit({ kind: "self-snapshot", state: selfConsciousness.snapshot(), at: nowIso() });
  });
  const unselfBrainState = bus.on("brain-state", (e) => {
    if (e.snapshot.priorUncertainty > 0.6) {
      selfConsciousness.react({ type: "confidence_drop", payload: { confidence: e.snapshot.confidence } });
    }
    bus.emit({ kind: "self-snapshot", state: selfConsciousness.snapshot(), at: nowIso() });
  });
  const unselfIdle = bus.on("idle-thought", (_e) => {
    selfConsciousness.react({ type: "idle", payload: {} });
    bus.emit({ kind: "self-snapshot", state: selfConsciousness.snapshot(), at: nowIso() });
  });
  const unselfDream = bus.on("imagination-dream", (e) => {
    selfConsciousness.react({ type: "dream", payload: { abstractions: e.abstractions.length } });
    bus.emit({ kind: "self-snapshot", state: selfConsciousness.snapshot(), at: nowIso() });
  });
  const unselfHealth = bus.on("organism-immune-event", (e) => {
    if (e.event.severity === "high" || e.event.severity === "critical") {
      selfConsciousness.react({ type: "health_change", payload: { score: 0.3, reason: e.event.detail } });
    }
    bus.emit({ kind: "self-snapshot", state: selfConsciousness.snapshot(), at: nowIso() });
  });

  // H4 — event-driven workspace: a high-salience signal (an immune/safety event,
  // a high-uncertainty cycle) can GRAB the conscious slot off the tonic timer
  // rather than waiting up to a full interval. Bounded by the refractory + energy
  // gate inside requestWorkspaceCycle; OFF by default (CONFIG.workspaceEventDriven),
  // so these handlers are a strict no-op unless opted in. Failure-isolated.
  const unWorkspaceImmune = bus.on("organism-immune-event", (e) => {
    if (e.event.severity === "high" || e.event.severity === "critical") {
      void requestWorkspaceCycle(`immune:${e.event.severity}`).catch(() => {});
    }
  });
  const unWorkspaceUncertain = bus.on("brain-state", (e) => {
    if (e.snapshot.priorUncertainty >= 0.6) {
      void requestWorkspaceCycle("high-uncertainty").catch(() => {});
    }
  });

  // Spinal cord — works the descending task queue (Hermes) on a tick so queued
  // motor commands get dispatched even with no client attached. An empty queue
  // ticks to a no-op; every dispatch is failure-isolated so a tick error can
  // never crash the core. The cord itself is a lazy singleton (getSpine).
  const SPINE_TICK_MS = 30_000;
  const spineTick = setInterval(() => {
    void getSpine()
      .tick()
      .catch((err) => console.warn("[brain-core] spine tick failed:", err));
  }, SPINE_TICK_MS);
  if (typeof spineTick.unref === "function") spineTick.unref();

  // A1 — autonomous goal pursuit. The tick itself never throws and returns a
  // no-go reason on every gate miss (quiet / rate / stage / energy / flag), so
  // a minute-cadence check is cheap; an actual pursuit fires at most once per
  // GOAL_PURSUIT_INTERVAL_MIN and runs the agent loop SAFE-ONLY.
  const PURSUIT_TICK_MS = 60_000;
  const pursuitTick = setInterval(() => {
    void autoPursuitTick().catch(() => {});
  }, PURSUIT_TICK_MS);
  if (typeof pursuitTick.unref === "function") pursuitTick.unref();

  // Observability spine (C1) — sample the brain's own vitals into the
  // brain_vitals time-series every minute (metrics registry snapshot + a few
  // subsystem gauges), and prune old telemetry. Every read is failure-isolated
  // so a sampling fault can never crash the core; gated on CONFIG.observability.
  let vitalsTick: NodeJS.Timeout | null = null;
  if (CONFIG.observability) {
    const VITALS_TICK_MS = 60_000;
    const sampleVitals = (): void => {
      try {
        const samples: Record<string, number> = {};
        const snap = metricsSnapshot();
        for (const [k, v] of Object.entries(snap.counters)) samples[`counter.${k}`] = v;
        for (const [k, v] of Object.entries(snap.gauges)) samples[`gauge.${k}`] = v;
        for (const [k, h] of Object.entries(snap.histograms)) {
          samples[`${k}.p50`] = h.p50;
          samples[`${k}.p95`] = h.p95;
        }
        try { samples["memory.count"] = getMemoryCount(); } catch { /* skip */ }
        try { samples["organism.health"] = organism.getHealthScore(); } catch { /* skip */ }
        try { samples["organism.activeGoals"] = organism.getActiveGoalTitles(99).length; } catch { /* skip */ }
        try { samples["stage"] = currentStage(); } catch { /* skip */ }
        try {
          // Generic numeric flatten (one level) so the exact neuromodulator
          // status shape doesn't need to be hard-coded here.
          const mods = getNeuromodulators().status() as Record<string, unknown>;
          for (const [k, v] of Object.entries(mods)) {
            if (typeof v === "number" && Number.isFinite(v)) {
              samples[`neuromod.${k}`] = v;
            } else if (v && typeof v === "object") {
              for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
                if (typeof v2 === "number" && Number.isFinite(v2)) samples[`neuromod.${k}.${k2}`] = v2;
              }
            }
          }
        } catch { /* skip */ }
        try {
          samples["errors.total"] = Object.values(getDiagnosticCounts()).reduce((a, b) => a + b, 0);
        } catch { /* skip */ }
        recordVitals(samples);
        pruneOldTelemetry();
      } catch (err) {
        console.warn("[brain-core] vitals sample failed:", err);
      }
    };
    vitalsTick = setInterval(sampleVitals, VITALS_TICK_MS);
    if (typeof vitalsTick.unref === "function") vitalsTick.unref();
    // One sample shortly after boot so /api/brain/vitals isn't empty on a fresh start.
    const warmVitals = setTimeout(sampleVitals, 5_000);
    if (typeof warmVitals.unref === "function") warmVitals.unref();
  }

  const runtime = new AgentRuntime({ bus, safety: createSafetyGate() });
  runtime.register(new ObserverAgent());
  runtime.register(new SummaryAgent());
  runtime.register(new SchedulerAgent());
  runtime.register(new SystemSensorAgent());
  // IdleAgent — wires the organism singleton into the saliency-weighted sample
  // so an idle thought leans toward goal-relevant memories when the organism
  // has active goals. The wiring is lazy (call only when act() needs it) so a
  // not-yet-awakened organism doesn't perturb the agent's init.
  runtime.register(
    new IdleAgent({
      saliencyProvider: () => {
        try {
          return {
            query: "",
            activeGoals: organism.getActiveGoalTitles(8),
            organismHealth: organism.getHealthScore(),
          };
        } catch {
          return null;
        }
      },
      // Curiosity = expected information gain over the causal world model.
      // gatherCuriosity() reads the causal ledger + organism health and scores
      // the uncertainty frontier. When it crosses CURIOSITY_EXPLORE_THRESHOLD
      // the IdleAgent fires `exploration-scheduled` instead of an idle thought.
      // Developmental gate: self-initiated exploration unlocks at stage 5
      // (returning null below it keeps the IdleAgent itself untouched).
      curiosityProvider: () => {
        try {
          if (!stageAllows("exploration")) return null;
          return gatherCuriosity().curiosity;
        } catch {
          return null;
        }
      },
    }),
  );

  await runtime.start();
  runtime.startCycle(AGENT_CYCLE_MS);

  // Brain Kernel — passive registry + the developmental-stage ratchet. Every
  // cognitive module registers a tiny status probe; a throwing probe reports
  // {ok:false} inside the kernel, never here. The kernel owns ONLY the new
  // stage-recompute interval — every existing timer keeps its owner.
  const kernel = getKernel();
  kernel.registerModule("organism", () => ({
    ok: true,
    detail: `health ${organism.getHealthScore().toFixed(2)}, ${organism.getActiveGoalTitles(99).length} active goal(s)`,
  }));
  kernel.registerModule("brain-state", () => {
    const s = brainState.snapshot();
    return { ok: true, detail: `${s.cycles} cycle(s), confidence ${s.confidence.toFixed(2)}` };
  });
  kernel.registerModule("workspace", () => ({
    ok: true,
    detail: CONFIG.workspaceEnabled ? `every ${CONFIG.workspaceIntervalMin}min` : "disabled",
  }));
  kernel.registerModule("imagination", () => ({
    ok: true,
    detail: `${imagination.snapshot().sessions.length} session(s)`,
  }));
  kernel.registerModule("evolution", () => ({
    ok: true,
    detail: `${evolution.snapshot().mutations.length} mutation(s)`,
  }));
  kernel.registerModule("swarm", () => ({ ok: true }));
  kernel.registerModule("self-consciousness", () => ({
    ok: true,
    detail: `${selfConsciousness.snapshot().recentMonologues.length} recent monologue(s)`,
  }));
  kernel.registerModule("beliefs", () => {
    const stats = getBeliefEngine().beliefStats();
    return { ok: true, detail: `${stats.total} belief(s), ${stats.contested} contested` };
  });
  kernel.registerModule("goal-manager", () => ({
    ok: true,
    detail: `tree depth ${goalManager.goalTreeDepth()}`,
  }));
  kernel.registerModule("procedural-memory", () => ({
    ok: true,
    detail: `${listProcedures(200).length} procedure(s)`,
  }));
  kernel.registerModule("stages", () => ({ ok: true, detail: `stage ${currentStage()}` }));
  kernel.registerModule("creativity", () => {
    const s = creativityStats();
    return { ok: true, detail: CONFIG.creativityEnabled ? `${s.total} idea(s), ${s.pending} pending` : "disabled" };
  });
  kernel.registerModule("hypotheses", () => {
    const s = getHypothesisEngine().hypothesisStats();
    return { ok: true, detail: CONFIG.hypotheses ? `${s.total} hypothesis(es), ${s.supported} supported` : "disabled" };
  });
  kernel.registerModule("cognitive-dna", () => {
    const d = getCognitiveDna().status();
    return { ok: true, detail: `${d.character} (${d.evolutionCount} step(s))` };
  });
  kernel.registerModule("emotions", () => {
    const e = emotionStatus();
    return { ok: true, detail: `${e.dominant.name} ${e.dominant.value.toFixed(2)}` };
  });
  kernel.registerModule("self-representation", () => {
    const { self } = getSelfRepresentation();
    return { ok: true, detail: `${self.character} · stage ${self.stage.stage} · ${self.goals.length} goal(s)` };
  });
  kernel.registerModule("spinal-cord", () => getSpine().health());
  kernel.registerModule("mcp-hub", () => getMcpHub().health());
  kernel.registerModule("goal-pursuit", () => ({
    ok: true,
    detail: CONFIG.goalPursuitAuto
      ? `auto (safe-only, ≥${CONFIG.goalPursuitIntervalMin}min apart)`
      : "manual-only",
  }));
  const stopStageCycle = kernel.startStageCycle();

  console.log(
    "[brain-core] agentic layer started (observer, summary, scheduler, system-sensor, idle, cognitive-swarm, imagination, evolution, organism, goal-manager, beliefs, self-consciousness, spinal-cord, kernel)",
  );

  return {
    async shutdown() {
      unbridge();
      unswarm();
      unevolution();
      unorganism();
      unselfLifecycle();
      unselfBrainState();
      unselfIdle();
      unselfDream();
      unselfHealth();
      unWorkspaceImmune();
      unWorkspaceUncertain();
      stopSwarmHeartbeat();
      stopDreaming();
      stopEvolutionLoop?.();
      stopOrganismAutonomy();
      goalManager.stop();
      stopStageCycle();
      kernel.stop();
      clearInterval(brainStateTick);
      clearInterval(spineTick);
      clearInterval(pursuitTick);
      if (workspaceTick) clearInterval(workspaceTick);
      if (vitalsTick) clearInterval(vitalsTick);
      await runtime.stop();
    },
  };
}
