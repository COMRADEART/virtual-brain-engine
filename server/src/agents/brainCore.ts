// BrainCore — boots the agentic layer and bridges its internal nervous system
// to the browser.
//
// This is the ONLY module that couples the agent layer to the WS hub + DB,
// which is what keeps core/eventBus.ts pure enough for the offline self-check.
// The bridge maps internal BrainEvents onto the existing `BrainBusMessage`
// wire shape so current frontend consumers (brainBus.ts, StatusBar, the pet)
// receive them with no protocol change.

import type { BrainBusMessage } from "../../../shared/pipeline.js";
import { getEventBus, type BrainEvent } from "../core/eventBus.js";
import { createCognitiveEvolutionEngine } from "../core/evolution.js";
import { createImaginationEngine } from "../core/imagination.js";
import { createPersistentOrganism } from "../core/organism.js";
import { createSafetyGate } from "../core/safety.js";
import { createCognitiveSwarm } from "../core/swarm.js";
import { broadcast } from "../ws/brainBus.js";
import { getMemoryCount } from "../db/repositories/memory.js";
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
  }
}

export interface BrainCoreHandle {
  shutdown(): Promise<void>;
}

export async function startBrainCore(): Promise<BrainCoreHandle> {
  const bus = getEventBus();

  const unbridge = bus.onAny((event) => {
    const message = toWireMessage(event);
    if (message) broadcast(message);
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
  const stopEvolutionLoop = evolution.startEvolutionLoop();
  evolution.evaluate();
  evolution.benchmarkStrategies({ goal: "local-first predictive cognitive architecture" });
  bus.emit({ kind: "evolution-snapshot", snapshot: evolution.snapshot(), at: new Date().toISOString() });
  const organism = createPersistentOrganism(bus);
  const unorganism = bus.onAny((event) => organism.observeBrainEvent(event));
  const stopOrganismAutonomy = organism.startAutonomy();
  organism.wake();

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
    }),
  );

  await runtime.start();
  runtime.startCycle(AGENT_CYCLE_MS);
  console.log(
    "[brain-core] agentic layer started (observer, summary, scheduler, system-sensor, idle, cognitive-swarm, imagination, evolution, organism)",
  );

  return {
    async shutdown() {
      unbridge();
      unswarm();
      unevolution();
      unorganism();
      stopSwarmHeartbeat();
      stopDreaming();
      stopEvolutionLoop();
      stopOrganismAutonomy();
      await runtime.stop();
    },
  };
}
