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
