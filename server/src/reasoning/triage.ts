// Triage router for the brain's "main thinking" entrypoint (POST /api/agent).
// A plain knowledge question goes straight to the fast 7-step pipeline (memory →
// citations → ranker → learning); a multi-step / "do X" / tool-shaped request
// enters the agentic loop. The loop with its deep-reason tool degenerates to one
// plain answer round on a simple question, so a misroute INTO the loop only
// costs latency — whereas a misroute to the bare pipeline makes a "do X" task
// get *answered* instead of *done*. So this is deliberately biased toward the
// loop: it only short-circuits to the pipeline when the input is CLEARLY a plain
// question. Pure + deterministic so the agent selfcheck can pin it.

export type AgentRoute = "pipeline" | "loop";

// Verbs / phrases that signal the user wants something DONE, not just answered.
const ACTION_SIGNALS = [
  "open ",
  "run ",
  "execute",
  "create ",
  "make ",
  "write ",
  "edit ",
  "delete",
  "remove ",
  "rename",
  "move ",
  "install",
  "build",
  "compile",
  "deploy",
  "commit",
  "push ",
  "clone",
  "checkout",
  "branch",
  "scan ",
  "index ",
  "fetch",
  "download",
  "search the web",
  "search online",
  "look up",
  "research ",
  "learn http",
  "learn from",
  "go online",
  "browse",
  "save ",
  "note ",
  "remind",
  "schedule",
  "list files",
  "list the files",
  "read the file",
  "read file",
  "list directory",
  "list the directory",
  "open the folder",
  "system info",
  "do this",
  "do that",
  "for me",
  "step by step",
  "and then",
  "then ",
];

// Plain-question openers — only used to ALLOW the pipeline short-circuit.
const QUESTION_OPENERS = [
  "what",
  "who",
  "when",
  "where",
  "why",
  "how",
  "which",
  "whose",
  "is ",
  "are ",
  "was ",
  "were ",
  "does ",
  "do ",
  "did ",
  "can ",
  "could ",
  "should ",
  "explain",
  "define",
  "describe",
  "tell me",
  "summarize",
  "summarise",
];

const URL_OR_PATH = /(https?:\/\/|www\.|[a-zA-Z]:[\\/]|\/[A-Za-z0-9._-]+\/|\\\\)/;

export function triage(promptRaw: string): AgentRoute {
  const prompt = promptRaw.trim();
  const lower = prompt.toLowerCase();

  // Concrete targets (URLs, file paths) almost always mean "act on this".
  if (URL_OR_PATH.test(prompt)) return "loop";

  // Any explicit action signal → the loop.
  if (ACTION_SIGNALS.some((sig) => lower.includes(sig))) return "loop";

  // Short, single-clause plain question with no action signal → the pipeline.
  const looksLikeQuestion =
    lower.endsWith("?") || QUESTION_OPENERS.some((q) => lower.startsWith(q));
  const short = prompt.length <= 240 && !lower.includes("\n");
  if (looksLikeQuestion && short) return "pipeline";

  // Uncertain → the loop (it can still just answer).
  return "loop";
}
