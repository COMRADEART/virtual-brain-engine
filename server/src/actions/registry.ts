// THE ALLOWLIST. An action is executable iff it appears in REGISTRY. This is the
// single source of truth for (a) which actions exist, (b) their risk tier, and
// (c) their argument schema. The resolver may only ever propose an id present
// here; the executor re-derives risk + schema from here by id and never trusts a
// risk/surface field on a caller-submitted plan.

import { z } from "zod";
import { CONFIG } from "../config.js";
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
  "deep-research": {
    id: "deep-research",
    title: "Deep research (cited report)",
    description:
      "Run an iterative, multi-source investigation: decompose the question into sub-questions, " +
      "gather from local memory AND (when LOCAL_ONLY is off) the live web across several rounds, " +
      "synthesize a cited report, and save it to memory. Use for 'deeply research X', 'do thorough " +
      "research on X', 'investigate X'. Egresses, so gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: {
      question: "the question to research deeply",
      maxRounds: "research rounds, 1-5 (default 3)",
      breadth: "sub-questions per round, 1-8 (default 4)",
      maxPages: "web pages per sub-question, 1-10 (default 3)",
    },
    schema: z
      .object({
        question: z.string().min(1).max(4000),
        maxRounds: z.number().int().min(1).max(5).optional(),
        breadth: z.number().int().min(1).max(8).optional(),
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
  "github-learn-repo": {
    id: "github-learn-repo",
    title: "Learn a specific GitHub repo",
    description:
      "Read ONE specific GitHub repository's README into memory by owner/name or URL (e.g. 'deepbeepmeep/Wan2GP' or 'https://github.com/deepbeepmeep/Wan2GP') so the brain learns it and can cite it later. Use for 'add this repo to the brain', 'learn this github repo', 'remember <repo-url>'. Egresses, so gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: {
      repo: "the repository as owner/name or a github.com URL",
    },
    schema: z
      .object({
        repo: z.string().min(1).max(200),
      })
      .strict(),
  },
  // --- MCP marketplace ("find skills + MCP servers the brain can use") --------
  "mcp-market-search": {
    id: "mcp-market-search",
    title: "Find MCP servers/tools",
    description:
      "Search the MCP marketplace (registry) for external tool servers the brain could use — returns each server's id, name, transport, package/url and description. Use for 'find an MCP server for X', 'what tools can I add', 'search the MCP market'. Discovery only (does NOT connect anything). Egresses, so gated by LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: {
      query: "what capability/tool to look for (e.g. 'github', 'postgres', 'browser')",
      limit: "max results, 1-50 (default from MCP_MARKET_MAX)",
    },
    schema: z
      .object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  },
  "mcp-market-add": {
    id: "mcp-market-add",
    title: "Add an MCP server",
    description:
      "Connect a discovered MCP server so its tools become usable by the brain (they register as confirm-tier actions). Pass the fields from an mcp-market-search result. The launch command is built from a fixed npx/uvx template — you cannot supply a raw command. Requires MCP_ENABLED; stdio servers ride ALLOW_SHELL, remote ones ride LOCAL_ONLY.",
    risk: "confirm",
    surface: "server",
    params: {
      id: "short id for the server (from search results)",
      transport: "stdio | http | sse",
      package: "stdio: the npm/pypi package to run (from search results)",
      registry: "stdio: 'npm' or 'pypi'",
      url: "http/sse: the server endpoint URL",
    },
    schema: z
      .object({
        id: z.string().min(1).max(60),
        transport: z.enum(["stdio", "http", "sse"]),
        package: z.string().max(214).optional(),
        registry: z.enum(["npm", "pypi"]).optional(),
        url: z
          .string()
          .url()
          .max(2048)
          .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL")
          .optional(),
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
  // --- Coding mastery (verify-until-correct) ---------------------------------
  // apply-patch makes a guarded literal find/replace edit to a file; run-build /
  // run-tests run a real build/test command and return its exit code so the agent
  // loop SEES failures and self-corrects until verification passes. All confirm-
  // tier. run-build/run-tests spawn a child process, so — like run-command — they
  // are only in the registry when ALLOW_SHELL is on; the executor re-checks the
  // flag. apply-patch is a guarded file write (not a process), so it is NOT shell-
  // gated — it shares write-file's path guard.
  "apply-patch": {
    id: "apply-patch",
    title: "Edit a file (patch)",
    description:
      "Apply one or more literal find/replace edits to a text file (absolute path). Each `find` must occur exactly once unless `all` is true. Use this to fix or modify code precisely. Sensitive locations are refused.",
    risk: "confirm",
    surface: "server",
    params: {
      path: "absolute path to the file to edit",
      edits: 'array of {find, replace, all?} — find must be present (and unique unless all:true)',
    },
    schema: z
      .object({
        path: z.string().min(1).max(4096),
        edits: z
          .array(
            z
              .object({
                find: z.string().min(1).max(20_000),
                replace: z.string().max(20_000),
                all: z.boolean().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict(),
  },
  "run-build": {
    id: "run-build",
    title: "Build / type-check",
    description:
      "Run a build or type-check command in a directory and return its exit code + output. Defaults to the project's build script. Use this to verify code compiles. A non-zero exit means it failed — read the output and fix it.",
    risk: "confirm",
    surface: "server",
    params: {
      cwd: "absolute path to the project/working directory",
      command: "optional build command (defaults to 'npm run build')",
      timeoutMs: "optional kill timeout in ms (1000-600000)",
    },
    schema: z
      .object({
        cwd: z.string().min(1).max(4096),
        command: z.string().min(1).max(8000).optional(),
        timeoutMs: z.number().int().min(1000).max(600_000).optional(),
      })
      .strict(),
  },
  "run-tests": {
    id: "run-tests",
    title: "Run tests",
    description:
      "Run the test suite in a directory and return its exit code + output. Defaults to the project's test script. Use this to verify code works. A non-zero exit means tests failed — read the output and fix the code, then run again.",
    risk: "confirm",
    surface: "server",
    params: {
      cwd: "absolute path to the project/working directory",
      command: "optional test command (defaults to 'npm test')",
      timeoutMs: "optional kill timeout in ms (1000-600000)",
    },
    schema: z
      .object({
        cwd: z.string().min(1).max(4096),
        command: z.string().min(1).max(8000).optional(),
        timeoutMs: z.number().int().min(1000).max(600_000).optional(),
      })
      .strict(),
  },
  // --- "Do any task on the laptop" -------------------------------------------
  // The universal computer-control primitives. They run a REAL child process on
  // the user's own machine, so they are confirm-tier and only surfaced to the
  // resolver / agent loop / UI when CONFIG.allowShell is on (see the list
  // functions below; the executor independently re-checks the flag). This is the
  // broadest capability in the brain — the confirm gate + audit are the guard.
  "run-command": {
    id: "run-command",
    title: "Run a command",
    description:
      "Run any shell command on this computer (PowerShell on Windows, /bin/sh otherwise) and return its output. The universal 'do anything on my PC' tool: install software, control apps, automate files, query the system, chain steps. Output is captured and size-capped; the command is killed after a timeout. Prefer a single self-contained command line.",
    risk: "confirm",
    surface: "server",
    params: {
      command: "the shell command line to run",
      cwd: "optional absolute working directory (defaults to the home folder)",
      timeoutMs: "optional kill timeout in ms (1000-600000)",
    },
    schema: z
      .object({
        command: z.string().min(1).max(8000),
        cwd: z.string().min(1).max(4096).optional(),
        timeoutMs: z.number().int().min(1000).max(600_000).optional(),
      })
      .strict(),
  },
  "launch-app": {
    id: "launch-app",
    title: "Launch an app",
    description:
      "Start an application or open a document on this computer by name or path (e.g. 'notepad', 'code', 'chrome', or an absolute path). Use this to open programs. Runs detached so it never blocks.",
    risk: "confirm",
    surface: "server",
    params: {
      app: "the app name or absolute path to launch",
      args: "optional space-separated arguments to pass",
    },
    schema: z
      .object({
        app: z.string().min(1).max(4096),
        args: z.string().max(8000).optional(),
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

// The shell ("do any task") actions are gated behind CONFIG.allowShell. When the
// flag is off we hide them from every caller (resolver, agent loop, UI) so the
// model can't even propose them; the executor re-checks the flag independently.
const SHELL_ACTION_IDS: ReadonlySet<string> = new Set(["run-command", "launch-app", "run-build", "run-tests"]);

export function isShellAction(id: string): boolean {
  return SHELL_ACTION_IDS.has(id);
}

function isVisibleAction(def: ActionDef): boolean {
  return !SHELL_ACTION_IDS.has(def.id) || CONFIG.allowShell;
}

export function listActionDefs(): ActionDef[] {
  return Object.values(REGISTRY).filter(isVisibleAction);
}

// The UI-facing view: every field of ActionSpec EXCEPT the (non-serialisable)
// zod schema.
export function listActionSpecs(): ActionSpec[] {
  return Object.values(REGISTRY)
    .filter(isVisibleAction)
    .map(({ schema: _schema, ...spec }) => spec);
}

// A hidden shell action (ALLOW_SHELL off) resolves to null/false here too — NOT
// just in the catalog — so a disabled action is indistinguishable from one that
// never existed: executeAction takes its clean 403 "not allowlisted" path BEFORE
// the confirm gate / token consumption / audit, instead of resolving the def and
// only stopping at the handler's belt-and-suspenders flag re-check.
export function getActionDef(id: string): ActionDef | null {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, id)) return null;
  if (SHELL_ACTION_IDS.has(id) && !CONFIG.allowShell) return null;
  return REGISTRY[id as ActionId];
}

export function isAllowlisted(id: string): id is ActionId {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, id)) return false;
  if (SHELL_ACTION_IDS.has(id) && !CONFIG.allowShell) return false;
  return true;
}

// Raw static-registry membership, INDEPENDENT of CONFIG.allowShell. isAllowlisted
// hides shell actions when ALLOW_SHELL=off (so a disabled action 403s cleanly),
// but a disabled-yet-reserved id must NOT be free for a dynamic skill to claim:
// executeAction checks isDynamicAction() before the static def, so a dynamic skill
// registered under e.g. "run-command" while shell is off would permanently shadow
// the built-in if shell were later enabled. Collision checks use THIS, not
// isAllowlisted, to keep the allowlist's id space uniquely owned.
export function isRegisteredId(id: string): boolean {
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
