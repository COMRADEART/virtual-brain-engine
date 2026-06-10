// Central cognitive loop — read the unified BrainState.
//
//   GET /api/brain/state                    the most recently active snapshot
//                                           (attention map + working memory +
//                                           goals + confidence + learning).
//   GET /api/brain/state?conversationId=X   that conversation's exact state
//                                           (BrainState is keyed per
//                                           conversation; concurrent asks no
//                                           longer share a workspace).
//
// Read-only; the loop is written from inside the 7-step pipeline (perceive /
// attend / recordReasoning), never from the client. Mirrors routes/organism.ts.

import { Router } from "express";
import { getBrainState } from "../core/brainState.js";

export const brainRouter = Router();

brainRouter.get("/brain/state", (req, res) => {
  const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
  res.json(getBrainState().snapshot(conversationId));
});
