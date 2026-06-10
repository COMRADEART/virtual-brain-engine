// Central cognitive loop — read the unified BrainState + the "real brain"
// layer's status surfaces.
//
//   GET  /api/brain/state                    the most recently active snapshot
//                                            (attention map + working memory +
//                                            goals + confidence + learning).
//   GET  /api/brain/state?conversationId=X   that conversation's exact state.
//   GET  /api/brain/modulators               neuromodulator levels + the
//                                            derived consumer signals.
//   GET  /api/brain/selfmodel                measured calibration bins + the
//                                            per-domain competence map.
//   GET  /api/brain/episodes[?day=ISO]       segmented experience episodes.
//   POST /api/brain/sleep                    run one sleep cycle now
//                                            (distill + decay + segment) —
//                                            the runtime check for the layer.
//   POST /api/brain/workspace                run one global-workspace cycle
//                                            now (bid → micro-thought).
//
// The loop itself is written from inside the 7-step pipeline (perceive /
// attend / recordReasoning), never from the client. Mirrors routes/organism.ts.

import { Router } from "express";
import { getBrainState } from "../core/brainState.js";
import { getNeuromodulators } from "../core/neuromodulators.js";
import { calibrationSummary, loadSelfModelState } from "../core/selfModel.js";
import { associationCount } from "../memory/hebbian.js";
import { runSleepCycle } from "../memory/sleepCycle.js";
import { buildEpisodes, listEpisodes } from "../memory/episodes.js";
import { runWorkspaceCycle } from "../core/workspace.js";
import { loadPredictiveState } from "../reasoning/predictiveProcessing.js";

export const brainRouter = Router();

brainRouter.get("/brain/state", (req, res) => {
  const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
  res.json(getBrainState().snapshot(conversationId));
});

brainRouter.get("/brain/modulators", (_req, res) => {
  res.json(getNeuromodulators().status());
});

brainRouter.get("/brain/selfmodel", (_req, res) => {
  const state = loadSelfModelState();
  res.json({
    calibration: calibrationSummary(state),
    feedbackObservations: state.feedbackObservations,
    competence: state.competence,
    predictive: { observations: loadPredictiveState().observations },
    hebbianAssociations: associationCount(),
  });
});

brainRouter.get("/brain/episodes", (req, res) => {
  const day = typeof req.query.day === "string" ? req.query.day : undefined;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  res.json({ episodes: listEpisodes(limit, day) });
});

brainRouter.post("/brain/sleep", (_req, res) => {
  void runSleepCycle()
    .then((sleep) => {
      const episodes = buildEpisodes();
      res.json({ sleep, episodes });
    })
    .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
});

brainRouter.post("/brain/workspace", (_req, res) => {
  void runWorkspaceCycle()
    .then((report) => res.json(report))
    .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
});
