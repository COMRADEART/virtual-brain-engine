// Routes for repository analysis and skill generation.
//
//   POST /api/repo/analyze     analyze a cloned repository
//   POST /api/repo/generate   generate skills from a cloned repo
//   POST /api/repo/register   generate AND register skills

import { Router } from "express";
import { z } from "zod";
import { generateSkillsFromRepo, analyzeRepo } from "../skills/generator.js";
import { registerSkill } from "../actions/dynamicRegistry.js";
import { isExcludedPath } from "../ingest/governance.js";
import { resolve } from "node:path";

export const repoRouter = Router();

// POST /api/repo/analyze — analyze a cloned repository
const analyzeSchema = z.object({
  path: z.string().min(1).max(4096),
});

repoRouter.post("/repo/analyze", async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { path } = parsed.data;
  const resolved = resolve(path);

  // Security check
  if (isExcludedPath(resolved)) {
    res.status(403).json({ error: "refused: path is a sensitive location" });
    return;
  }

  const analysis = await analyzeRepo(resolved);
  if (!analysis) {
    res.status(404).json({ error: "no files found in repository" });
    return;
  }

  res.json(analysis);
});

// POST /api/repo/generate — generate skills from a cloned repository
const generateSchema = z.object({
  path: z.string().min(1).max(4096),
  maxSkills: z.number().int().min(1).max(20).optional(),
});

repoRouter.post("/repo/generate", async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { path, maxSkills = 10 } = parsed.data;
  const resolved = resolve(path);

  // Security check
  if (isExcludedPath(resolved)) {
    res.status(403).json({ error: "refused: path is a sensitive location" });
    return;
  }

  const skills = await generateSkillsFromRepo(resolved);
  const limited = skills.slice(0, maxSkills);

  res.json({
    generated: limited.length,
    skills: limited,
  });
});

// POST /api/repo/register — generate AND register skills from a cloned repo
const registerSchema = z.object({
  path: z.string().min(1).max(4096),
  maxSkills: z.number().int().min(1).max(20).optional(),
  autoRegister: z.boolean().optional(),
});

repoRouter.post("/repo/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { path, maxSkills = 10, autoRegister = false } = parsed.data;
  const resolved = resolve(path);

  // Security check
  if (isExcludedPath(resolved)) {
    res.status(403).json({ error: "refused: path is a sensitive location" });
    return;
  }

  // API key check
  const apiKey = req.headers["x-skill-key"] as string | undefined;
  if (!apiKey || apiKey.length < 16) {
    res.status(403).json({ error: "skill registration requires a valid API key (x-skill-key header)" });
    return;
  }

  const skills = await generateSkillsFromRepo(resolved);
  const limited = skills.slice(0, maxSkills);

  if (!autoRegister) {
    res.json({
      generated: limited.length,
      skills: limited,
      message: "Set autoRegister: true to automatically register these skills",
    });
    return;
  }

  // Register each skill
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const { skill } of limited) {
    const result = await registerSkill(skill, true);
    results.push({
      id: skill.id,
      ok: result.ok,
      error: result.error,
    });
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  res.json({
    total: results.length,
    succeeded,
    failed,
    results,
  });
});