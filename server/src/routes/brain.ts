// Central cognitive loop — read the unified BrainState.
//
//   GET /api/brain/state   the live snapshot (attention map + working memory +
//                          goals + confidence + priorUncertainty + learning).
//
// Read-only; the loop is written from inside the 7-step pipeline (perceive /
// attend / recordReasoning), never from the client. Mirrors routes/organism.ts.

import { Router } from "express";
import { getBrainState } from "../core/brainState.js";

export const brainRouter = Router();

brainRouter.get("/brain/state", (_req, res) => {
  res.json(getBrainState().snapshot());
});
