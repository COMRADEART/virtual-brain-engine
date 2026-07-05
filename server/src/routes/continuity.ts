// Routes for the memory continuity briefing ("since last time").
//
//   GET /api/continuity?format=full|spoken
//
//   - `full`   — returns the full structured briefing for the Mind panel
//                (episodes 24h, active beliefs, active goals, recent
//                conversations, open questions).
//   - `spoken` — returns just the greeting + briefing text for the pet's
//                voice (TTS, sentence-streamed through the speech policy).
//
// The gathering logic (which DB calls feed the briefing) lives here; the
// PROSE builder is PURE in `core/continuity.ts`. This file is the I/O seam.

import { Router } from "express";
import { buildBriefing, buildSpokenBriefing, type ContinuityInput } from "../core/continuity.js";
import { listEpisodes } from "../memory/episodes.js";
import { getBeliefEngine } from "../core/beliefs.js";
import { getGoalManager } from "../core/goalManager.js";
import { getBrainState } from "../core/brainState.js";
import { listConversations } from "../db/repositories/conversations.js";

export const continuityRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Gather the data the briefing needs. Failure-isolated: a missing
 *  subsystem returns an empty slice; the briefing says "no record" instead
 *  of crashing the pet's first-paint. */
function gather(now: Date): ContinuityInput {
  const today = { hour: now.getHours(), weekday: now.toLocaleDateString("en-US", { weekday: "long" }) };

  // Episodes from the last 24h (the brain groups conversation memories into
  // episodes every few hours — see memory/episodes.ts). The query returns
  // recent-first; we filter the 24h window client-side.
  const since = now.getTime() - DAY_MS;
  const episodes24h = listEpisodes(20)
    .filter((e) => new Date(e.endedAt).getTime() >= since)
    .map((e) => ({ title: e.title, summary: `${e.itemCount} item${e.itemCount === 1 ? "" : "s"}`, at: e.endedAt }))
    .slice(0, 5);

  // Active beliefs, top 3 by confidence. The engine returns newest-first;
  // we sort by confidence descending and slice.
  const beliefsRaw = getBeliefEngine().listBeliefs({ status: "active", limit: 50 });
  const beliefs = beliefsRaw
    .map((b) => ({ statement: b.statement, confidence: b.confidence }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  // Active goals (the manager returns a tree; we flatten to leaf titles).
  const manager = getGoalManager();
  const forest = manager.goalTree();
  const goals: { title: string; progress: number; paused?: boolean }[] = [];
  const walk = (nodes: typeof forest, depth = 0): void => {
    for (const n of nodes) {
      if (n.goal.status === "active" && depth >= 1) {
        goals.push({ title: n.goal.title, progress: n.goal.progress });
      }
      if (n.children.length > 0) walk(n.children, depth + 1);
    }
  };
  walk(forest);
  const activeGoals = goals.sort((a, b) => b.progress - a.progress).slice(0, 5);

  // Recent conversations (top 5, latest first).
  const convos = listConversations(5).map((c) => ({
    title: c.title ?? null,
    at: c.createdAt ?? c.updatedAt ?? new Date().toISOString(),
  }));

  // Hours since the last chat. `Infinity` when there is none — the greeting
  // builder treats that as "first time".
  let hoursSinceLastChat = Number.POSITIVE_INFINITY;
  if (convos.length > 0) {
    const lastAt = new Date(convos[0].at).getTime();
    if (Number.isFinite(lastAt)) {
      hoursSinceLastChat = Math.max(0, (now.getTime() - lastAt) / (60 * 60_000));
    }
  }

  // Open questions: the most recent working-memory "open-question" items
  // from the global brain state. BrainState.snapshot() returns the full
  // shape (attention, working memory, goals, confidence, etc.).
  let openQuestions: { text: string; from: string }[] = [];
  try {
    const snap = getBrainState().snapshot();
    openQuestions = snap.workingMemory
      .filter((w) => w.kind === "open-question")
      .map((w) => ({ text: w.label, from: "working memory" }));
  } catch {
    // Working memory is optional — a missing/empty brain returns no questions.
  }

  // People — there is no `people` table today (roadmap item). We surface
  // conversations the user referenced by name as a soft stand-in: read the
  // first non-empty title from the last 3 conversations if it looks like a
  // person name (Title Case, 1-2 words). This is a best-effort heuristic
  // that the next slice can replace with a real `people` table without
  // changing the contract.
  const people: { name: string; lastSeen: string }[] = [];

  return {
    episodes24h,
    beliefs,
    goals: activeGoals,
    people,
    openQuestions,
    recentConversations: convos,
    hoursSinceLastChat,
    today,
  };
}

continuityRouter.get("/continuity", async (req, res) => {
  const format = (req.query.format as string | undefined) ?? "full";
  const input = gather(new Date());
  if (format === "spoken") {
    res.json(buildSpokenBriefing(input));
    return;
  }
  res.json(buildBriefing(input));
});
