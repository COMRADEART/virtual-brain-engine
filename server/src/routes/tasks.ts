// Routes for the task executor agent.
//
//   POST /api/tasks/execute   execute a task
//   GET  /api/tasks           list tasks
//   GET  /api/tasks/:id       get a specific task
//   GET  /api/tasks/skills    list available skills

import { Router } from "express";
import { z } from "zod";
import { executeTask, getTask, listTasks, getAvailableSkills } from "../agents/taskExecutor.js";

export const tasksRouter = Router();

// POST /api/tasks/execute — execute a task
const executeSchema = z.object({
  task: z.string().min(1).max(2000),
  autoGenerateSkills: z.boolean().optional(),
});

tasksRouter.post("/tasks/execute", async (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { task, autoGenerateSkills = true } = parsed.data;

  // This can take a while, so we could return immediately with a task ID
  // and let the client poll, but for simplicity we'll wait for completion.
  const result = await executeTask(task, autoGenerateSkills);

  res.json(result);
});

// GET /api/tasks — list all tasks
tasksRouter.get("/tasks", async (_req, res) => {
  const tasks = listTasks();
  res.json({
    total: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      task: t.task,
      status: t.status,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      stepCount: t.steps.length,
    })),
  });
});

// GET /api/tasks/:id — get a specific task
tasksRouter.get("/tasks/:id", async (req, res) => {
  const { id } = req.params;
  const task = getTask(id);

  if (!task) {
    res.status(404).json({ error: `task ${id} not found` });
    return;
  }

  res.json(task);
});

// GET /api/tasks/skills — list available dynamic skills
tasksRouter.get("/tasks/skills", async (_req, res) => {
  const skills = getAvailableSkills();
  res.json({
    total: skills.length,
    skills,
  });
});