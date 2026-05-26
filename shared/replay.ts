// Cross-boundary contract for theta-gamma replay events.
//
// Lives in shared/ (zero runtime deps) so both the Node server (which produces
// the events in server/src/memory/replayService.ts) and the browser engine
// (which animates them in src/engine/signalSimulation.ts) can import the type
// without the frontend reaching into the server's source tree.

/** A hippocampal/neocortical replay pulse broadcast to the frontend for neural animation. */
export interface ReplayEvent {
  type: "replay";
  memoryIds: string[];
  region: "hippocampus" | "neocortex";
  thetaPhase: "peak" | "trough";
  timestamp: string;
}
