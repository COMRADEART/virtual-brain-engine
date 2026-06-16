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
//   GET  /api/brain/beliefs[?status=…]       the belief engine's stances +
//                                            stats (core/beliefs.ts).
//   GET  /api/brain/goals/tree               the goal hierarchy (goalManager).
//   POST /api/brain/goals/decompose          LLM-decompose one goal into
//                                            child goals ({goalId}).
//   GET  /api/brain/procedures               procedural memory (what works).
//   GET  /api/brain/kernel                   the Brain Kernel status surface:
//                                            every cognitive module + the
//                                            developmental stage + activity.
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
import { getBeliefEngine, type BeliefStatus } from "../core/beliefs.js";
import { getGoalManager } from "../core/goalManager.js";
import { getKernel } from "../core/kernel.js";
import { stageAllows, FEATURE_STAGE } from "../core/stages.js";
import { getNeuromodulators } from "../core/neuromodulators.js";
import { calibrationSummary, loadSelfModelState } from "../core/selfModel.js";
import { associationCount } from "../memory/hebbian.js";
import { listProcedures } from "../memory/procedural.js";
import { runSleepCycle } from "../memory/sleepCycle.js";
import { buildEpisodes, listEpisodes } from "../memory/episodes.js";
import { runWorkspaceCycle } from "../core/workspace.js";
import { loadPredictiveState } from "../reasoning/predictiveProcessing.js";
import { getNarrative, synthesizeNarrative } from "../core/narrative.js";
import { getCognitiveDna } from "../core/cognitiveDna.js";
import { emotionStatus } from "../core/emotions.js";
import { gatherSkills, skillSummary } from "../core/skills.js";
import { getSelfRepresentation } from "../core/selfRepresentation.js";
import { getUserModel } from "../core/userModel.js";
import { memoryDnaStats } from "../memory/memoryDna.js";
import { runCreativeCycle, listIdeas, creativityStats } from "../core/creativity.js";
import { getHypothesisEngine } from "../core/hypotheses.js";
import type { HypothesisStatus } from "../../../shared/hypotheses.js";

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

brainRouter.get("/brain/beliefs", (req, res) => {
  const raw = typeof req.query.status === "string" ? req.query.status : undefined;
  const status: BeliefStatus | undefined =
    raw === "active" || raw === "contested" || raw === "weakening" || raw === "retired"
      ? raw
      : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const engine = getBeliefEngine();
  res.json({ stats: engine.beliefStats(), beliefs: engine.listBeliefs({ status, limit }) });
});

brainRouter.get("/brain/goals/tree", (_req, res) => {
  const manager = getGoalManager();
  res.json({ depth: manager.goalTreeDepth(), tree: manager.goalTree() });
});

brainRouter.post("/brain/goals/decompose", (req, res) => {
  const goalId = typeof req.body?.goalId === "string" ? req.body.goalId : "";
  if (!goalId) {
    res.status(400).json({ error: "goalId required" });
    return;
  }
  // Developmental gate (fail-open): decomposition unlocks at stage 4.
  if (!stageAllows("goal-decomposition")) {
    res.json({
      decomposed: 0,
      childIds: [],
      reason: `locked until developmental stage ${FEATURE_STAGE["goal-decomposition"]}`,
    });
    return;
  }
  void getGoalManager()
    .decomposeGoal(goalId)
    .then((report) => res.json(report))
    .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
});

brainRouter.get("/brain/kernel", (_req, res) => {
  res.json(getKernel().status());
});

brainRouter.get("/brain/procedures", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ procedures: listProcedures(limit) });
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

// COGNITIVE DNA — the slow, evolving personality (curiosity/creativity/logic/
// riskTolerance/sociality/memoryFocus) + its derived character line.
brainRouter.get("/brain/dna", (_req, res) => {
  res.json(getCognitiveDna().status());
});

// EMOTIONS — the eight named emotions, derived from the affective substrates.
brainRouter.get("/brain/emotions", (_req, res) => {
  res.json(emotionStatus());
});

// SKILLS — "what am I good at, and am I getting better?" (procedural-backed).
brainRouter.get("/brain/skills", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const skills = gatherSkills(limit);
  res.json({ skills, summary: skillSummary(skills) });
});

// SELF — the unified self-representation (who / what / why / what to become).
brainRouter.get("/brain/self", (_req, res) => {
  res.json(getSelfRepresentation().self);
});

// USER — Theory of Mind: the brain's model of the PERSON it talks with
// (recurring interests, sustained domains, preferred style, current goals) plus
// the grounding preamble (empty until the model has formed).
brainRouter.get("/brain/user", (_req, res) => {
  res.json(getUserModel().status());
});

// MEMORY DNA — affect/trust/verification tally over a recent memory sample
// (the "living memory" surface).
brainRouter.get("/brain/memory-dna/stats", (req, res) => {
  const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 500));
  res.json(memoryDnaStats(limit));
});

// CREATIVITY — distant-concept recombinations (the ideas the brain invented).
brainRouter.get("/brain/creativity", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ stats: creativityStats(), ideas: listIdeas(limit) });
});

// Run one creative cycle now (bridge two distant memories) — the runtime check.
brainRouter.post("/brain/creative", (_req, res) => {
  void runCreativeCycle()
    .then((report) => res.json(report))
    .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
});

// HYPOTHESES — the scientific-reasoning ledger (open → tested → supported/refuted).
brainRouter.get("/brain/hypotheses", (req, res) => {
  const raw = typeof req.query.status === "string" ? req.query.status : undefined;
  const status: HypothesisStatus | undefined =
    raw === "open" || raw === "testing" || raw === "supported" || raw === "refuted" || raw === "retired"
      ? raw
      : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const engine = getHypothesisEngine();
  res.json({ stats: engine.hypothesisStats(), hypotheses: engine.listHypotheses({ status, limit }) });
});

// Form (optional) + test a hypothesis now — the runtime check. Body:
// { statement?, causeClass?, effectClass? } forms then tests; else runs a sleep tick.
brainRouter.post("/brain/hypotheses/test", (req, res) => {
  try {
    const engine = getHypothesisEngine();
    const statement = typeof req.body?.statement === "string" ? req.body.statement : "";
    if (statement) {
      const formed = engine.formHypothesisFromObservation(statement, {
        causeClass: typeof req.body?.causeClass === "string" ? req.body.causeClass : null,
        effectClass: typeof req.body?.effectClass === "string" ? req.body.effectClass : null,
      });
      if (!formed) {
        res.status(400).json({ error: "could not form hypothesis (statement too short?)" });
        return;
      }
      res.json(engine.test(formed.id));
      return;
    }
    res.json(engine.sleepTick());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// MYTHOS — the brain's self-narrative ("who I am / how I've grown").
brainRouter.get("/brain/narrative", (_req, res) => {
  res.json({ narrative: getNarrative() });
});

// Synthesize one self-narrative now (distill + persist) — the runtime check.
brainRouter.post("/brain/narrate", (_req, res) => {
  void synthesizeNarrative()
    .then((report) => res.json(report))
    .catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : String(err) }));
});
