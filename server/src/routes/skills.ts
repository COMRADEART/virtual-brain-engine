// Routes for dynamic skill management.
//
//   GET  /api/skills          list all registered skills (static + dynamic)
//   GET  /api/skills/dynamic  list only dynamic skills
//   POST /api/skills/register register a new skill
//   DELETE /api/skills/:id    unregister a skill

import { Router } from "express";
import { z } from "zod";
import { listActionSpecs } from "../actions/registry.js";
import {
  registerSkill,
  unregisterSkill,
  listDynamicActions,
  isDynamicAction,
  getDynamicAction,
  SkillDefinitionSchema,
} from "../actions/dynamicRegistry.js";

export const skillsRouter = Router();

// GET /api/skills — list all skills (static + dynamic)
skillsRouter.get("/skills", async (_req, res) => {
  const staticSkills = listActionSpecs();
  const dynamicSkills = listDynamicActions();

  res.json({
    static: staticSkills,
    dynamic: dynamicSkills,
    all: [...staticSkills, ...dynamicSkills],
  });
});

// GET /api/skills/dynamic — list only dynamic skills
skillsRouter.get("/skills/dynamic", async (_req, res) => {
  res.json(listDynamicActions());
});

// POST /api/skills/register — register a new skill
const registerSchema = SkillDefinitionSchema;

skillsRouter.post("/skills/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // For now, require a special header to register skills (basic protection)
  // In production, this would be tied to authentication.
  const apiKey = req.headers["x-skill-key"] as string | undefined;
  if (!apiKey || apiKey.length < 16) {
    res.status(403).json({ error: "skill registration requires a valid API key (x-skill-key header)" });
    return;
  }

  const result = await registerSkill(parsed.data);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ ok: true, id: result.id });
});

// DELETE /api/skills/:id — unregister a dynamic skill
skillsRouter.delete("/skills/:id", async (req, res) => {
  const { id } = req.params;

  if (!isDynamicAction(id)) {
    res.status(404).json({ error: `skill ${id} not found or is a static skill` });
    return;
  }

  const apiKey = req.headers["x-skill-key"] as string | undefined;
  if (!apiKey || apiKey.length < 16) {
    res.status(403).json({ error: "skill unregistration requires a valid API key (x-skill-key header)" });
    return;
  }

  const result = await unregisterSkill(id);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ ok: true });
});

// GET /api/skills/:id — get a specific skill
skillsRouter.get("/skills/:id", async (req, res) => {
  const { id } = req.params;

  const staticDef = listActionSpecs().find((s) => s.id === id);
  const dynamicDef = getDynamicAction(id);

  if (staticDef) {
    res.json({ ...staticDef, source: "static" });
    return;
  }

  if (dynamicDef) {
    res.json({ ...dynamicDef, source: "dynamic" });
    return;
  }

  res.status(404).json({ error: `skill ${id} not found` });
});