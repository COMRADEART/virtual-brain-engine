// Task Executor Agent — autonomously plans and executes tasks using git + skills.
//
// Given a natural language task, the agent:
// 1. Breaks the task into actionable steps
// 2. Uses git actions to clone/fetch repositories
// 3. Generates skills from the code
// 4. Executes the steps sequentially
// 5. Reports results

import { cloneRepo, listRepoFiles, readRepoFile, getRepoStatus } from "../actions/git.js";
import { generateSkillsFromRepo, analyzeRepo } from "../skills/generator.js";
import { registerSkill, listDynamicActions, isDynamicAction } from "../actions/dynamicRegistry.js";
import { executeAction } from "../actions/executor.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";

export interface TaskStep {
  id: string;
  action: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
}

export interface TaskExecution {
  id: string;
  task: string;
  steps: TaskStep[];
  status: "planning" | "executing" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

// In-memory store of active/executed tasks (would be DB in production)
const tasks = new Map<string, TaskExecution>();

// Parse a task description into steps using the LLM
async function planTask(task: string): Promise<TaskStep[]> {
  const connector = getDefaultConnectorInstance();
  if (!connector) {
    // Fallback: simple step parsing without LLM
    return parseTaskFallback(task);
  }

  const systemPrompt = `You are a task planning assistant. Break down the user's task into concrete, executable steps.
Each step should be one of these action types:
- git-clone: clone a repository (args: url, optional branch)
- git-list-files: list files in a repo (args: path)
- git-read-file: read a file (args: path)
- generate-skills: analyze a repo and generate skills (args: path)
- execute-skill: run a registered skill (args: skillId, inputs)
- git-commit: commit changes (args: path, message, push)

Respond ONLY with a JSON array of steps, like:
[
  { "action": "git-clone", "args": { "url": "https://github.com/owner/repo" } },
  { "action": "git-list-files", "args": { "path": "/tmp/repo" } }
]

If no git operations are needed, return an empty array.`;

  try {
    // The Connector's send() takes a single prompt string + options (no native
    // multi-message / tool-calling); pass the system prompt via opts and read
    // the returned text directly.
    const text = await connector.send(task, { system: systemPrompt, format: "json", temperature: 0.1 });
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const steps = JSON.parse(jsonMatch[0]) as Array<{ action: string; args: Record<string, unknown> }>;
      return steps.map((s, i) => ({
        id: `step-${i + 1}`,
        action: s.action,
        args: s.args,
        status: "pending" as const,
      }));
    }
  } catch {
    // Fall back to simple parsing
  }

  return parseTaskFallback(task);
}

// Simple fallback parsing without LLM
function parseTaskFallback(task: string): TaskStep[] {
  const steps: TaskStep[] = [];
  const lower = task.toLowerCase();

  // Detect git clone
  const cloneMatch = task.match(/(?:clone|fetch|download)\s+(?:from\s+)?(https?:\/\/[^\s]+)/i);
  if (cloneMatch) {
    steps.push({
      id: "step-1",
      action: "git-clone",
      args: { url: cloneMatch[1] },
      status: "pending",
    });
  }

  // Detect file operations
  if (lower.includes("list") && (lower.includes("file") || lower.includes("directory"))) {
    steps.push({
      id: "step-2",
      action: "git-list-files",
      args: { path: "" }, // Will be filled from clone result
      status: "pending",
    });
  }

  // If no specific steps detected, assume we might need to clone and explore
  if (steps.length === 0) {
    steps.push({
      id: "step-1",
      action: "git-list-files",
      args: { path: "" },
      status: "pending",
    });
  }

  return steps;
}

// Execute a single step
async function executeStep(step: TaskStep, context: Record<string, unknown>): Promise<TaskStep> {
  let result: unknown;
  let error: string | undefined;

  try {
    switch (step.action) {
      case "git-clone": {
        const r = await cloneRepo(step.args.url as string, step.args.branch as string | undefined);
        if (!r.ok) {
          throw new Error(r.error);
        }
        result = r.data;
        // Store the cloned path in context for subsequent steps
        if (r.data && typeof r.data === "object") {
          const data = r.data as { path?: string };
          if (data.path) {
            context.lastClonePath = data.path;
          }
        }
        break;
      }

      case "git-list-files": {
        const path = (step.args.path as string) || (context.lastClonePath as string) || "";
        if (!path) {
          throw new Error("no path specified and no previous clone found");
        }
        const r = await listRepoFiles(path);
        if (!r.ok) {
          throw new Error(r.error);
        }
        result = r.data;
        break;
      }

      case "git-read-file": {
        const r = await readRepoFile(step.args.path as string);
        if (!r.ok) {
          throw new Error(r.error);
        }
        result = r.data;
        break;
      }

      case "git-status": {
        const path = (step.args.path as string) || (context.lastClonePath as string) || "";
        const r = await getRepoStatus(path);
        if (!r.ok) {
          throw new Error(r.error);
        }
        result = r.data;
        break;
      }

      case "generate-skills": {
        const path = (step.args.path as string) || (context.lastClonePath as string) || "";
        if (!path) {
          throw new Error("no path specified for skill generation");
        }
        const skills = await generateSkillsFromRepo(path);
        result = { generated: skills.length, skills: skills.map((s) => s.skill.id) };
        break;
      }

      case "execute-skill": {
        const skillId = step.args.skillId as string;
        const skillArgs = step.args.inputs || {};
        const r = await executeAction({ actionId: skillId, args: skillArgs });
        if (!r.ok) {
          throw new Error(r.error);
        }
        result = r.data;
        break;
      }

      case "register-skills": {
        const path = (step.args.path as string) || (context.lastClonePath as string) || "";
        if (!path) {
          throw new Error("no path specified for skill registration");
        }
        const skills = await generateSkillsFromRepo(path);
        const registered: string[] = [];
        for (const { skill } of skills) {
          const reg = await registerSkill(skill);
          if (reg.ok) {
            registered.push(skill.id);
          }
        }
        result = { registered: registered.length, ids: registered };
        break;
      }

      default:
        throw new Error(`unknown action: ${step.action}`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    ...step,
    status: error ? "failed" : "completed",
    result,
    error,
  };
}

// Main entry point: execute a task
export async function executeTask(task: string, autoGenerateSkills = true): Promise<TaskExecution> {
  const id = `task-${Date.now()}`;
  const execution: TaskExecution = {
    id,
    task,
    steps: [],
    status: "planning",
    createdAt: new Date().toISOString(),
  };

  tasks.set(id, execution);

  try {
    // Phase 1: Plan the task
    execution.status = "planning";
    const steps = await planTask(task);
    execution.steps = steps;

    if (steps.length === 0) {
      execution.status = "completed";
      execution.result = { message: "No steps needed for this task" };
      execution.completedAt = new Date().toISOString();
      return execution;
    }

    // Phase 2: Execute steps
    execution.status = "executing";
    const context: Record<string, unknown> = {};

    for (let i = 0; i < execution.steps.length; i++) {
      const step = execution.steps[i];
      step.status = "running";

      // Auto-fill path from previous clone if needed
      if ((step.action === "git-list-files" || step.action === "generate-skills" || step.action === "register-skills") && !step.args.path) {
        step.args.path = context.lastClonePath;
      }

      const result = await executeStep(step, context);
      execution.steps[i] = result;

      if (result.status === "failed") {
        execution.status = "failed";
        execution.error = `Step ${i + 1} failed: ${result.error}`;
        execution.completedAt = new Date().toISOString();
        return execution;
      }
    }

    execution.status = "completed";
    execution.result = {
      completedSteps: execution.steps.length,
      steps: execution.steps.map((s) => ({ id: s.id, action: s.action, status: s.status })),
    };
    execution.completedAt = new Date().toISOString();

  } catch (err) {
    execution.status = "failed";
    execution.error = err instanceof Error ? err.message : String(err);
    execution.completedAt = new Date().toISOString();
  }

  return execution;
}

// Get a task by ID
export function getTask(id: string): TaskExecution | undefined {
  return tasks.get(id);
}

// List all tasks
export function listTasks(): TaskExecution[] {
  return Array.from(tasks.values()).sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

// Get registered skills
export function getAvailableSkills() {
  return listDynamicActions();
}