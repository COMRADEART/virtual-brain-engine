// THE ALLOWLIST. An action is executable iff it appears in REGISTRY. This is the
// single source of truth for (a) which actions exist, (b) their risk tier, and
// (c) their argument schema. The resolver may only ever propose an id present
// here; the executor re-derives risk + schema from here by id and never trusts a
// risk/surface field on a caller-submitted plan.

import { z } from "zod";
import type { ActionId, ActionRiskTier, ActionSpec } from "../../../shared/actions.js";

export interface ActionDef extends ActionSpec {
  // Authoritative argument validator. `.strict()` rejects unknown keys so a
  // model (or a caller) cannot smuggle an extra parameter past validation.
  schema: z.ZodTypeAny;
}

const REGISTRY: Record<ActionId, ActionDef> = {
  "search-memory": {
    id: "search-memory",
    title: "Search memory",
    description: "Search the brain's stored memories by keyword and return matches.",
    risk: "safe",
    surface: "server",
    params: { query: "the text to search for", limit: "max results, 1-25 (default 8)" },
    schema: z
      .object({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(25).optional(),
      })
      .strict(),
  },
  "recent-memories": {
    id: "recent-memories",
    title: "Recent memories",
    description: "List the most recently updated memories.",
    risk: "safe",
    surface: "server",
    params: { limit: "max results, 1-50 (default 10)" },
    schema: z
      .object({
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  },
  "create-note": {
    id: "create-note",
    title: "Create note",
    description: "Save a new note into the brain's memory.",
    risk: "confirm",
    surface: "server",
    params: { content: "the note text", title: "optional short title" },
    schema: z
      .object({
        content: z.string().min(1).max(8000),
        title: z.string().max(200).optional(),
      })
      .strict(),
  },
  "trigger-scan": {
    id: "trigger-scan",
    title: "Scan files into memory",
    description: "Walk the configured scan roots and index files into the brain's memory.",
    risk: "confirm",
    surface: "server",
    params: {},
    schema: z.object({}).strict(),
  },
  "learn-url": {
    id: "learn-url",
    title: "Learn from a web page",
    description:
      "Fetch a web page by URL and save its readable text into memory. Use when the user wants the brain to read, learn, or remember a link/article/page. Egresses, so it is gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: { url: "the http(s) URL of the page to read and learn" },
    schema: z
      .object({
        url: z
          .string()
          .url()
          .max(4096)
          .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL"),
      })
      .strict(),
  },
  // --- Hybrid local+internet ("FRIDAY goes online") --------------------------
  "web-search": {
    id: "web-search",
    title: "Search the web",
    description:
      "Search the live internet and return the top results (title, URL, snippet). Use when the user wants current/online information. Egresses, so gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: { query: "what to search the web for", limit: "max results, 1-10 (default 5)" },
    schema: z
      .object({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(10).optional(),
      })
      .strict(),
  },
  "research-web": {
    id: "research-web",
    title: "Research the web (learn it)",
    description:
      "Search the web AND read the top pages into memory so the brain learns them — then they can be cited in future answers. Use for 'research X', 'learn about X online', 'find out about X'. Egresses, so gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: { query: "the topic to research and learn", maxPages: "pages to read, 1-10 (default 3)" },
    schema: z
      .object({
        query: z.string().min(1).max(500),
        maxPages: z.number().int().min(1).max(10).optional(),
      })
      .strict(),
  },
  // --- GitHub project discovery ("learn from popular repos") -----------------
  "github-search": {
    id: "github-search",
    title: "Find popular GitHub repos",
    description:
      "Search GitHub for the most-starred repositories about a topic (default >1k stars). Returns name, stars, URL and description. Egresses, so gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: {
      query: "the topic/keywords to search GitHub for",
      minStars: "minimum stars (default 1000)",
      language: "optional language filter (e.g. TypeScript)",
      limit: "max repos, 1-50 (default 10)",
    },
    schema: z
      .object({
        query: z.string().min(1).max(200),
        minStars: z.number().int().min(1).max(1_000_000).optional(),
        language: z.string().max(30).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  },
  "github-learn": {
    id: "github-learn",
    title: "Learn from popular GitHub repos",
    description:
      "Find the most-starred GitHub repos about a topic (default >1k stars) AND read their READMEs into memory so the brain learns them — then they can be cited in future answers. Use for 'learn about X from github', 'find popular repos for X'. Egresses, so gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: {
      query: "the topic to find popular repos for and learn",
      minStars: "minimum stars (default 1000)",
      language: "optional language filter (e.g. TypeScript)",
      limit: "max repos to learn, 1-50 (default 10)",
    },
    schema: z
      .object({
        query: z.string().min(1).max(200),
        minStars: z.number().int().min(1).max(1_000_000).optional(),
        language: z.string().max(30).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  },
  // --- System actions (Node handlers in the server process) ------------------
  "system-info": {
    id: "system-info",
    title: "System info",
    description: "Report this computer's CPU, memory, disk, platform and uptime. Read-only.",
    risk: "safe",
    surface: "server",
    params: {},
    schema: z.object({}).strict(),
  },
  "list-directory": {
    id: "list-directory",
    title: "List a folder",
    description: "List the files and subfolders in a directory on this computer.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the folder to list" },
    schema: z.object({ path: z.string().min(1).max(4096) }).strict(),
  },
  "read-file": {
    id: "read-file",
    title: "Read a file",
    description: "Read the text contents of a file on this computer into the brain (size-capped).",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the text file to read" },
    schema: z.object({ path: z.string().min(1).max(4096) }).strict(),
  },
  "write-file": {
    id: "write-file",
    title: "Write a file",
    description: "Write text to a file on this computer (creates or overwrites). Sensitive locations are refused.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to write", content: "the text to write" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
        content: z.string().max(200_000),
      })
      .strict(),
  },
  // --- Phase 3b: OS-surface actions (executed in Tauri, not the server) ------
  "open-path": {
    id: "open-path",
    title: "Open file or folder",
    description: "Open a file or folder with the operating system's default app.",
    risk: "confirm",
    surface: "os",
    params: { path: "absolute path to the file or folder" },
    schema: z.object({ path: z.string().min(1).max(4096) }).strict(),
  },
  "open-url": {
    id: "open-url",
    title: "Open a web page",
    description: "Open an http(s) URL in the default browser.",
    risk: "confirm",
    surface: "os",
    params: { url: "an http or https URL" },
    schema: z
      .object({
        url: z
          .string()
          .url()
          .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL"),
      })
      .strict(),
  },
  // --- Git actions -------------------------------------------------------------
  "git-clone": {
    id: "git-clone",
    title: "Clone a GitHub repository",
    description: "Clone a git repository (https only) to a sandboxed temp directory. Use this to fetch code from GitHub before reading or modifying files.",
    risk: "confirm",
    surface: "server",
    params: { url: "the git repository URL (https://github.com/owner/repo)", branch: "optional branch to checkout" },
    schema: z
      .object({
        url: z
          .string()
          .url()
          .refine((u) => /^https?:\/\//i.test(u), "must be an https URL"),
        branch: z.string().max(100).optional(),
      })
      .strict(),
  },
  "git-list-files": {
    id: "git-list-files",
    title: "List repository files",
    description: "List the files and folders in a cloned repository.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the cloned repository" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
      })
      .strict(),
  },
  "git-read-file": {
    id: "git-read-file",
    title: "Read a file from repository",
    description: "Read the contents of a file from a cloned repository.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the file" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
      })
      .strict(),
  },
  "git-write-file": {
    id: "git-write-file",
    title: "Write a file to repository",
    description: "Write content to a file in a cloned repository. Creates the file if it doesn't exist, overwrites if it does.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to write", content: "the file content" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
        content: z.string().max(500_000),
      })
      .strict(),
  },
  "git-status": {
    id: "git-status",
    title: "Show repository changes",
    description: "Show the current git status (modified, staged, untracked files) in a cloned repository.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the cloned repository" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
      })
      .strict(),
  },
  "git-commit": {
    id: "git-commit",
    title: "Commit changes",
    description: "Commit staged changes in a cloned repository with a message. Optionally push to remote.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the repository", message: "commit message", push: "whether to push after commit (default false)" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
        message: z.string().min(1).max(500),
        push: z.boolean().optional(),
      })
      .strict(),
  },
  "git-branches": {
    id: "git-branches",
    title: "List branches",
    description: "List all branches in a cloned repository.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the cloned repository" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
      })
      .strict(),
  },
  "git-checkout": {
    id: "git-checkout",
    title: "Checkout a branch",
    description: "Checkout a different branch in a cloned repository.",
    risk: "confirm",
    surface: "server",
    params: { path: "absolute path to the repository", branch: "branch name to checkout" },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
        branch: z.string().min(1).max(100),
      })
      .strict(),
  },
};

export function listActionDefs(): ActionDef[] {
  return Object.values(REGISTRY);
}

// The UI-facing view: every field of ActionSpec EXCEPT the (non-serialisable)
// zod schema.
export function listActionSpecs(): ActionSpec[] {
  return Object.values(REGISTRY).map(({ schema: _schema, ...spec }) => spec);
}

export function getActionDef(id: string): ActionDef | null {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id)
    ? REGISTRY[id as ActionId]
    : null;
}

export function isAllowlisted(id: string): id is ActionId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

export interface ArgValidation {
  ok: boolean;
  args?: Record<string, unknown>;
  error?: string;
}

export function validateArgs(id: ActionId, rawArgs: unknown): ArgValidation {
  const def = REGISTRY[id];
  const parsed = def.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, args: parsed.data as Record<string, unknown> };
}
