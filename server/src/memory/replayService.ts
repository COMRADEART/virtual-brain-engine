import { getMemoryById } from "./memoryLifecycle.js";
import { strengthenPathway } from "./memoryStrength.js";
import { getHotMemories, getRelatedMemories } from "./accessPatternTracker.js";
import { broadcast } from "../ws/brainBus.js";

// Replay event broadcast to frontend for neural animation
export interface ReplayEvent {
  type: "replay";
  memoryIds: string[];
  region: "hippocampus" | "neocortex";
  thetaPhase: "peak" | "trough";
  timestamp: string;
}

// Stats tracking replay efficacy
export interface ReplayStats {
  replayed: number;
  strengthened: number;
  durationMs: number;
}

// Neuroscience constants
const THETA_FREQ = 6; // Hz — hippocampal theta rhythm
const GAMMA_FREQ = 40; // Hz — neocortical gamma bursts
const REPLAY_DURATION_MS = 1000; // Simulate 1s replay per cycle
const REPLAY_INTERVAL_MS = 5 * 60 * 1000; // Every 5min during sleep
const STDP_WINDOW_MS = 20; // Spike-timing window for plasticity

let replayRunning = false;

/**
 * Create WebSocket event for replay visualization.
 * @param memoryIds Memories being replayed
 * @param region Target region (hippocampus/neocortex)
 * @param thetaPhase Theta rhythm phase (peak/trough)
 */
function makeReplayEvent(
  memoryIds: string[],
  region: "hippocampus" | "neocortex",
  thetaPhase: "peak" | "trough"
): ReplayEvent {
  return {
    type: "replay",
    memoryIds,
    region,
    thetaPhase,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Apply Spike-Timing-Dependent Plasticity (STDP) to boost pathways.
 * Strengthens connection if postsynaptic spike follows presynaptic within STDP window.
 * @param memoryId Presynaptic memory
 * @param relatedIds Postsynaptic memories
 * @param thetaPhase Theta phase modulating plasticity
 */
function applySTDP(
  memoryId: string,
  relatedIds: string[],
  thetaPhase: "peak" | "trough"
): void {
  // Theta phase modulates plasticity direction:
  //   Trough → strengthen relevant pathways (LTP)
  //   Peak   → would weaken irrelevant pathways (LTD)
  // The pathway store (strengthenPathway) is strengthen-only, so on peaks we
  // emit the replay event for visualization without mutating weights.
  const strengthen = thetaPhase === "trough";

  for (const relatedId of relatedIds) {
    if (strengthen) {
      strengthenPathway(memoryId, relatedId);
    }
    // Broadcast for neural animation
    broadcast(makeReplayEvent([memoryId, relatedId], "neocortex", thetaPhase));
  }
}

/**
 * Simulate hippocampal-neocortical replay for memory consolidation.
 * - Theta peaks: hippocampus drives replay
 * - Theta troughs: neocortex replays in gamma bursts
 * - STDP: strengthens pathways based on spike timing
 *
 * @param recentMemoryIds Ids of recent memories to replay
 * @param cycles Number of replay cycles (default: 3)
 */
export async function replayMemories(
  recentMemoryIds: string[],
  cycles = 3
): Promise<ReplayStats> {
  if (replayRunning) {
    return { replayed: 0, strengthened: 0, durationMs: 0 };
  }
  replayRunning = true;
  const start = Date.now();
  let replayed = 0;
  let strengthened = 0;

  try {
    const memories = recentMemoryIds
      .map((id) => getMemoryById(id))
      .filter(Boolean);

    for (let cycle = 0; cycle < cycles; cycle++) {
      // Theta peak: hippocampus drives replay
      // Random replay — prioritizes recent or strong memories
      const thetaPeakIds = memories
        .sort(() => Math.random() - 0.5)
        .slice(0, 5)
        .map((m) => m!.id);
      replayed += thetaPeakIds.length;
      broadcast(makeReplayEvent(thetaPeakIds, "hippocampus", "peak"));

      // STDP: boost pathways during theta peak
      // Hippocampus → Neocortex transfer
      for (const id of thetaPeakIds) {
        const related = getRelatedMemories(id, 3);
        applySTDP(id, related, "peak");
        strengthened += related.length;
      }

      // Theta trough: neocortex replays in gamma bursts
      // Prioritize high-importance memories
      const thetaTroughIds = memories
        .sort((a, b) => (b?.importance ?? 0) - (a?.importance ?? 0))
        .slice(0, 8)
        .map((m) => m!.id);
      replayed += thetaTroughIds.length;
      broadcast(makeReplayEvent(thetaTroughIds, "neocortex", "trough"));

      // STDP: boost pathways during theta trough
      // Neocortex → Neocortex crosstalk
      for (const id of thetaTroughIds) {
        const related = getRelatedMemories(id, 4);
        applySTDP(id, related, "trough");
        strengthened += related.length;
      }

      // Simulate replay duration (~1 second)
      await new Promise((resolve) => setTimeout(resolve, REPLAY_DURATION_MS));
    }
  } finally {
    replayRunning = false;
  }

  return {
    replayed,
    strengthened,
    durationMs: Date.now() - start,
  };
}

/**
 * Background service: periodic replay during sleep/idle.
 */
export function startSleepReplay(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const recentMemories = getHotMemories(24, 10).map((m) => m.id);
      void replayMemories(recentMemories);
    } catch (err) {
      console.warn("[replay] sleep replay failed:", err);
    }
  }, REPLAY_INTERVAL_MS);
}