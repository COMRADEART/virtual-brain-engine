import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// server/src → project root
const REPO_ROOT = resolve(__dirname, "..", "..");

// Pin dotenv to the repo-root .env explicitly. The bare loadEnv() reads from
// process.cwd(), which is whatever directory the server was launched from — so
// API keys placed in the root .env would silently fail to load when the server
// is started from server/ or via a selfcheck. Pinning the path makes key
// loading deterministic regardless of cwd.
loadEnv({ path: resolve(REPO_ROOT, ".env") });

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  defaultScanRoot: string;
  ollamaBaseUrl: string;
  ollamaChatModel: string;
  ollamaEmbeddingModel: string;
  embeddingDim: number;
  // Hard cap to keep an accidentally-pointed-at-C: scan from spiraling.
  maxFilesPerScan: number;
  maxFileBytes: number;
  // Frontend dev origin -- relaxed CORS on /api so the Vite app can hit /api/ask
  // and /api/health without proxying.
  allowedOrigin: string;
  // When true (default), the connector registry refuses any baseUrl whose host
  // is not loopback or RFC1918. Flip with LOCAL_ONLY=false if you really want
  // to point the server at a remote OpenAI-compatible endpoint; the UI then
  // surfaces a "Remote model in use" badge to make that explicit.
  localOnly: boolean;
  // Free-tier remote providers (NVIDIA NIM + Google Gemini). These are seeded as
  // *disabled, non-default* connectors only when the matching API key env var is
  // present, and only their two exact hosts may bypass the LOCAL_ONLY gate. Keys
  // themselves live in the root .env (gitignored) and are read from process.env
  // at request time — never stored in the DB. Model names are env-overridable so
  // a user can point at a different free model without touching code.
  nvidiaChatModel: string;
  geminiChatModel: string;
  // Enable the P2P Civilization subsystem. Binds port 8788; start/stop is
  // tracked in the shutdown handler.
  civilizationEnabled: boolean;
  // --- Hybrid local+internet ("FRIDAY goes online") -------------------------
  // Which web-search backend to use. "auto" picks: local SearXNG (if SEARXNG_URL
  // set) → a keyed API (Brave/Tavily/Exa, if a key is in the env) → the no-key
  // DuckDuckGo HTML fallback. Force one with "searxng"|"brave"|"tavily"|"exa"|
  // "duckduckgo". Egress for every backend goes through the SAME LOCAL_ONLY gate
  // as web fetching: a local SearXNG is reachable even under LOCAL_ONLY=true; a
  // remote provider is reachable only when LOCAL_ONLY=false.
  webSearchProvider: string;
  // When (and whether) an /api/ask answer reaches the internet alongside local
  // memory. "smart" (default) only searches when local memory is thin/weak or the
  // query looks time-sensitive; "always" searches every query; "ondemand" keeps
  // /api/ask purely local (the web is reached only via explicit research/learn
  // actions); "off" disables hybrid augmentation entirely.
  webSearchMode: "smart" | "always" | "ondemand" | "off";
  // Base URL of a local SearXNG instance (e.g. http://127.0.0.1:8080). Empty =
  // not configured. Used for local-first web search; must be loopback/RFC1918 to
  // be reachable under LOCAL_ONLY=true.
  searxngUrl: string;
  // Master switch for the pipeline's local+web fusion. Even with LOCAL_ONLY=false
  // and a provider configured, set HYBRID_RESEARCH=false to keep /api/ask local.
  hybridResearch: boolean;
  // How many search results a single hybrid augmentation / research action will
  // fetch + ingest. Bounded to keep one query from pulling the whole web.
  webResearchMaxPages: number;
  // --- RL-adaptive RAG (ML/RL/RAG layer) ------------------------------------
  // Multi-query RAG: when local memory is thin/weak, rephrase the query a few
  // ways, retrieve each, and Reciprocal-Rank-Fuse the union for higher recall.
  // ON by default but trigger-gated (it costs one extra LLM round-trip, only
  // spent when local memory looks weak). Set MULTI_QUERY_RAG=false to disable.
  multiQueryRag: boolean;
  // How many ALTERNATIVE phrasings to generate (1-3); total queries = this + 1.
  multiQueryVariants: number;
  // Learned LEXICAL query-aware reranker that reorders the top-K after the LTR
  // ranker (term overlap / title match — features the doc-side LTR can't see).
  // Trains online on the citation signal; ON by default, degrades to a no-op
  // until it has trained. Set RERANKER=false to disable.
  rerankerEnabled: boolean;
  // Citation faithfulness: after the response step, check that each [m:<id>]
  // citation's claim is actually SUPPORTED by the cited memory (cheap lexical
  // entailment). Unfaithful citations get a note in Uncertain AND are dropped
  // from the ranker/reranker training signal so the brain stops rewarding
  // citation PRESENCE alone. OFF by default — opt in with CITATION_FAITHFULNESS=true.
  citationFaithfulness: boolean;
  // RL adaptive controller: a contextual bandit that learns the augment /
  // retrieval-k / multi-query / model-routing decisions from the dense citation
  // reward. OFF by default — it warm-starts at the heuristics and only helps once
  // feedback accrues, so it's opt-in. Flip with ADAPTIVE_CONTROLLER=true.
  adaptiveController: boolean;
  // Per-SLOT real-observation count below which a bandit slot returns EXACTLY the
  // heuristic decision (no exploration) — the no-regression floor. (Gated on the
  // slot's total pulls: during warm-up the slot always returns the heuristic arm,
  // so all observations accrue to it; a per-ARM gate would deadlock the non-
  // heuristic arms, which get zero pulls until the slot is warm.)
  banditWarmAt: number;
  // --- Agentic loop ("main thinking") ---------------------------------------
  // The Odysseus-style multi-round ReAct loop behind POST /api/agent. It runs
  // ALONGSIDE the 7-step pipeline (a triage router picks which a request hits)
  // and runs every tool through the SAME permissioned executor.
  // Max reasoning rounds before the loop is cut off and asked to wrap up. Each
  // round is one LLM call (+ at most one tool). Bounded so a wedged model can't
  // spin forever; clamped to 1..50.
  agentMaxRounds: number;
  // Default confirm-tier handling when a request doesn't specify confirmMode.
  // "ask" pauses for per-action approval; "scope" runs within a granted ceiling;
  // "safe-only" never runs confirm-tier autonomously. Default "ask" (safest).
  agentConfirmMode: "ask" | "scope" | "safe-only";
  // When true (default), POST /api/agent runs a cheap triage router that sends a
  // plain question straight to the 7-step pipeline and only multi-step / tool /
  // "do X" requests into the loop. Set AGENT_TRIAGE=false to always use the loop.
  agentTriage: boolean;
  // --- "Do any task on the laptop" -------------------------------------------
  // When true, the registry exposes the confirm-tier `run-command` / `launch-app`
  // actions — the universal "do anything on this PC" primitives (an arbitrary
  // shell command + launching an app). They run a real child process on the
  // user's machine, so this is the broadest capability in the brain. It is STILL
  // fully gated: every invocation goes through the permissioned executor (confirm
  // token OR a user-granted session scope) and is audited; nothing runs
  // unapproved. Default ON for this personal computer-brain, since the whole
  // point is to act on the machine. Set ALLOW_SHELL=false to remove these actions
  // from the allowlist entirely (the resolver/loop then can't even propose them).
  allowShell: boolean;
  // Hard cap (ms) on a single run-command before it is killed. Clamped 1s..600s.
  shellTimeoutMs: number;
  // Optional prompt variant tag for A/B testing. When set, every usage log entry
  // carries this as `stepTimings.prompt_variant`, enabling per-variant quality
  // comparison. Empty = no variant tagging. Default: ""
  promptVariant: string;
  // Memory dedup audit: similarity threshold (0-1) for near-duplicate detection.
  dedupSimilarityThreshold: number;
  // Memory dedup: max pairs to report per audit run.
  dedupMaxPairs: number;
  // Memory dedup: actually MERGE (delete the older near-duplicate) on the boot
  // + daily audit. DEFAULT OFF — auto-merge is irreversible deletion, and at the
  // default 0.92 cosine threshold real DBs surface many distinct-but-related
  // memories as "near-duplicates" (two different certs, two different addresses).
  // When off, the audit still runs and LOGS the candidate count, but deletes
  // nothing. Opt in only after reviewing candidates (and likely raising the
  // threshold). Same default-off safety posture as ingest consent / civilization.
  dedupAutoMerge: boolean;
  // --- GitHub project discovery ("learn from popular repos") -----------------
  // Optional GitHub API token. When set, it is sent ONLY in the Authorization
  // header (never a URL/query/log) and raises GitHub's low unauthenticated rate
  // limit (search 10→30/min, core 60→5000/hr). Read from process.env at call
  // time; NEVER stored in the DB. Empty = unauthenticated (works, just slower).
  githubToken: string;
  // Minimum stars a repo must have to be discovered/ingested ("more than 1k").
  githubMinStars: number;
  // Max repos a single discovery/learn run touches — caps the README fetch
  // budget so one query can't spam GitHub (single page, no multi-page crawl).
  githubMaxRepos: number;
  // --- Own-model auto-train --------------------------------------------------
  // When true, the brain automatically starts LoRA continued-pretraining on its
  // memory corpus on every server boot (if enough corpus exists and enough time
  // has passed since the last run). The trained model is seeded as a disabled,
  // non-default Ollama connector so it never silently becomes the /api/ask
  // model. OFF by default — training is compute-intensive and you should opt in.
  autoStartOwnModel: boolean;
  // When true (the default), the brain trains its OWN from-scratch model
  // (worker/train — the char-level GPT over the memory corpus) automatically on
  // server boot, with progress streamed to the UI's TrainingBar. Cheap relative
  // to the LoRA pass (minutes on GPU), skipped gracefully when the worker is
  // down, and rate-limited by autoStartMinIntervalMs so dev restarts don't
  // retrain in a loop. Set AUTO_START_SCRATCH_LLM=false to opt out.
  autoStartScratchLlm: boolean;
  // When true (the default), both trainers (the LoRA own-model pass and the
  // from-scratch GPT) filter the exported memory corpus to mostly-English
  // documents before training. The base models are bilingual (Qwen) and a
  // mixed-language personal corpus measurably pulls the adapted voice toward
  // the other language; this keeps the brain's own model speaking English.
  // Set TRAIN_ENGLISH_MOSTLY=false to train on the full multilingual corpus.
  trainEnglishMostly: boolean;
  // Minimum corpus chars required before auto-train will fire.
  autoStartMinCorpusChars: number;
  // Minimum milliseconds between auto-train runs (default 7 days).
  autoStartMinIntervalMs: number;
  // When true, remote provider failures in /api/ask fall back to local Ollama
  // instead of surfacing an error. The response includes a [degraded] tag so
  // the user knows they got a weaker answer. OFF by default — transparent is
  // safer than silent degradation.
  remoteFallback: boolean;
  remoteRetryAttempts: number;
  routingAutoOptimize: boolean;
  usageLogRetentionDays: number;
  // --- "Real brain" layer -----------------------------------------------------
  // Hebbian associative recall: co-cited memories wire together
  // (memory/hebbian.ts); retrieval passes the relation graph into the ranker
  // and strong associations pull missed neighbours into the candidate pool.
  // ON by default — bounded, anchored below real hits, no-op on an empty graph.
  hebbianRetrieval: boolean;
  // Predictive processing: predict retrieval quality before the memory step,
  // learn from the prediction error (surprise → norepinephrine; "expected to
  // know but didn't" → open question). ON by default — zero perturbation until
  // the EMA model has enough observations to predict at all.
  predictiveProcessing: boolean;
  // Sleep cycle: nightly episodic→semantic distillation + Hebbian decay +
  // episode segmentation (memory/sleepCycle.ts, memory/episodes.ts). ON by
  // default; degrades to a no-op report without a connector.
  sleepCycle: boolean;
  sleepIntervalHours: number;
  // Global workspace: subsystems bid (open questions, curiosity, goals); the
  // winner gets one LLM micro-thought per interval, written back as memory.
  // ON by default; skipped quietly when no connector is configured.
  workspaceEnabled: boolean;
  workspaceIntervalMin: number;
  // --- Fast mode ("be like Fable: fast + efficient") --------------------------
  // Biases the pipeline's adaptive compute toward the cheap path: more queries
  // answer directly from retrieved memory (embed → search → stream) instead of
  // paying two blocking LLM round-trips (reasoning + contradiction check) before
  // the answer streams, and the streamed answer is length-capped so it stays
  // tight. Genuinely hard/compound queries still take the full path. ON by
  // default for this personal brain; set BRAIN_FAST_MODE=false for the thorough
  // path on every query.
  fastMode: boolean;
  // Depth gate used when fastMode is on. A query's difficulty must reach THIS to
  // take the full (slow, thorough) route; below it answers on the fast path.
  // Higher than the base DEPTH_DIFFICULTY_THRESHOLD (0.45) so single-trigger
  // explanatory queries go fast, while compound/multi-clause ones stay full.
  fastModeDepthThreshold: number;
  // Max tokens for the streamed answer in fast mode (request-level num_predict /
  // max_tokens). Keeps responses crisp instead of rambling to the context limit.
  fastModeMaxTokens: number;
  // --- Fable + Mythos upgrade -------------------------------------------------
  // FABLE F1 — shallow→full salvage: when a shallow (fast) route retrieves
  // nothing / weak memory, transparently escalate to the full path instead of
  // answering thin (the cascade "escalate on weak signal" pattern). ON by
  // default but inert unless retrieval is actually thin → no-regression on the
  // common fast case.
  fastSalvage: boolean;
  // Top retrieval score below which a shallow route is escalated (with 0 hits it
  // always escalates). [0,1].
  fastSalvageScoreFloor: number;
  // FABLE F2 — speculative parallel reasoning: on a genuinely hard (full +
  // high-difficulty) route, sample N reasoning drafts concurrently and keep the
  // most consistent by local lexical consensus (no judge, no logprobs). OFF by
  // default — it changes the hot-path LLM call count; opt in with
  // PARALLEL_REASONING=true. Failure-isolated → falls back to a single draft.
  parallelReasoning: boolean;
  // Number of parallel reasoning drafts (clamped 2..3).
  parallelReasoningDrafts: number;
  // FABLE F3 — outcome-learned adaptive compute: nudge the depth threshold from
  // observed citation outcomes, with a warm-start floor that returns the base
  // threshold EXACTLY until enough observations accrue (no-regression). OFF by
  // default — opt in with ADAPTIVE_DEPTH=true.
  adaptiveDepth: boolean;
  // Per-observation count below which adaptiveDepth returns the base threshold
  // unchanged (the no-regression warm-start floor).
  adaptiveDepthWarmAt: number;
  // MYTHOS M1 — narrative self-synthesis: during the sleep cycle, distill the
  // brain's identity material (beliefs/goals/stage/competence/episodes) into a
  // coherent first-person self-narrative (generative-agents-style reflection).
  // ON by default; degrades to a no-op without a connector, exactly like sleep.
  selfNarrative: boolean;
  // MYTHOS M2 — first-person inner monologue: the brain authors "I wonder… / I'm
  // working toward… / I keep turning over the belief that…" lines into the
  // cognition stream on the workspace cadence. ON by default; rate-limited.
  innerMonologue: boolean;
  // MYTHOS M3 — narrative-grounded reasoning: inject a compact first-person
  // identity preamble (from M1) into the reasoning + response prompts so answers
  // stay consistent with who the brain is. OFF by default — it changes hot-path
  // prompt content; opt in with NARRATIVE_GROUNDING=true.
  narrativeGrounding: boolean;
  // --- Scheduled SQLite backup ------------------------------------------------
  // The whole brain lives in one SQLite file; snapshot it with VACUUM INTO on
  // boot + an interval so a disk fault / bad migration is recoverable. ON by
  // default (cheap, local, bounded by retention).
  backupEnabled: boolean;
  backupIntervalHours: number;
  // How many snapshots to retain in <dataDir>/backups (oldest pruned first).
  backupKeep: number;
}

function num(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(envKey: string, fallback: string): string {
  const raw = process.env[envKey];
  return raw && raw.length > 0 ? raw : fallback;
}

function bool(envKey: string, fallback: boolean): boolean {
  const raw = process.env[envKey];
  if (!raw) {
    return fallback;
  }
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no" || v === "off") {
    return false;
  }
  if (v === "true" || v === "1" || v === "yes" || v === "on") {
    return true;
  }
  return fallback;
}

function oneOf<T extends string>(envKey: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[envKey] ?? "").trim().toLowerCase();
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

// data/brain.sqlite by default. Both are env-overridable so hermetic
// selfchecks/integration tests can point openDb() at a throwaway DB instead of
// the developer's real store (see scripts/memory-selfcheck.ts).
const DATA_DIR = str("BRAIN_DATA_DIR", resolve(REPO_ROOT, "data"));

export const CONFIG: ServerConfig = {
  port: num("PORT", 8787),
  host: str("HOST", "127.0.0.1"),
  dataDir: DATA_DIR,
  dbPath: str("BRAIN_DB_PATH", resolve(DATA_DIR, "brain.sqlite")),
  defaultScanRoot: str("DEFAULT_SCAN_ROOT", "C:\\Users\\allam\\projects"),
  ollamaBaseUrl: str("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
  ollamaChatModel: str("OLLAMA_CHAT_MODEL", "llama3.2:3b"),
  ollamaEmbeddingModel: str("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
  embeddingDim: num("EMBEDDING_DIM", 768),
  maxFilesPerScan: num("MAX_FILES_PER_SCAN", 50000),
  maxFileBytes: num("MAX_FILE_BYTES", 2 * 1024 * 1024),
  allowedOrigin: str("ALLOWED_ORIGIN", "http://127.0.0.1:5173"),
  localOnly: bool("LOCAL_ONLY", true),
  nvidiaChatModel: str("NVIDIA_CHAT_MODEL", "meta/llama-3.3-70b-instruct"),
  geminiChatModel: str("GEMINI_CHAT_MODEL", "gemini-2.0-flash"),
  civilizationEnabled: bool("CIVILIZATION_ENABLED", false),
  webSearchProvider: str("WEB_SEARCH_PROVIDER", "auto").toLowerCase(),
  webSearchMode: oneOf("WEB_SEARCH_MODE", ["smart", "always", "ondemand", "off"] as const, "smart"),
  searxngUrl: str("SEARXNG_URL", "").replace(/\/$/, ""),
  hybridResearch: bool("HYBRID_RESEARCH", true),
  webResearchMaxPages: Math.min(10, Math.max(1, num("WEB_RESEARCH_MAX_PAGES", 3))),
  multiQueryRag: bool("MULTI_QUERY_RAG", true),
  multiQueryVariants: Math.min(3, Math.max(1, num("MULTI_QUERY_VARIANTS", 2))),
  rerankerEnabled: bool("RERANKER", true),
  citationFaithfulness: bool("CITATION_FAITHFULNESS", false),
  adaptiveController: bool("ADAPTIVE_CONTROLLER", false),
  banditWarmAt: Math.max(1, num("BANDIT_WARM_AT", 30)),
  agentMaxRounds: Math.min(50, Math.max(1, num("AGENT_MAX_ROUNDS", 12))),
  agentConfirmMode: oneOf("AGENT_CONFIRM_MODE", ["ask", "scope", "safe-only"] as const, "ask"),
  agentTriage: bool("AGENT_TRIAGE", true),
  allowShell: bool("ALLOW_SHELL", true),
  shellTimeoutMs: Math.min(600_000, Math.max(1_000, num("SHELL_TIMEOUT_MS", 120_000))),
  promptVariant: str("PROMPT_VARIANT", ""),
  dedupSimilarityThreshold: num("DEDUP_SIMILARITY_THRESHOLD", 0.92),
  dedupMaxPairs: num("DEDUP_MAX_PAIRS", 50),
  dedupAutoMerge: bool("DEDUP_AUTO_MERGE", false),
  githubToken: str("GITHUB_TOKEN", ""),
  githubMinStars: Math.max(1, num("GITHUB_MIN_STARS", 1000)),
  githubMaxRepos: Math.min(50, Math.max(1, num("GITHUB_MAX_REPOS", 10))),
  autoStartOwnModel: bool("AUTO_START_OWN_MODEL", false),
  autoStartScratchLlm: bool("AUTO_START_SCRATCH_LLM", true),
  trainEnglishMostly: bool("TRAIN_ENGLISH_MOSTLY", true),
  autoStartMinCorpusChars: Math.max(0, num("AUTO_START_MIN_CORPUS_CHARS", 10_000)),
  autoStartMinIntervalMs: Math.max(0, num("AUTO_START_MIN_INTERVAL_MS", 7 * 24 * 60 * 60 * 1000)),
  remoteFallback: bool("REMOTE_FALLBACK", false),
  remoteRetryAttempts: Math.min(5, Math.max(0, num("REMOTE_RETRY_ATTEMPTS", 2))),
  routingAutoOptimize: bool("ROUTING_AUTO_OPTIMIZE", false),
  usageLogRetentionDays: Math.max(1, num("USAGE_LOG_RETENTION_DAYS", 30)),
  hebbianRetrieval: bool("HEBBIAN_RETRIEVAL", true),
  predictiveProcessing: bool("PREDICTIVE_PROCESSING", true),
  sleepCycle: bool("SLEEP_CYCLE", true),
  sleepIntervalHours: Math.max(1, num("SLEEP_INTERVAL_HOURS", 24)),
  workspaceEnabled: bool("WORKSPACE", true),
  workspaceIntervalMin: Math.max(1, num("WORKSPACE_INTERVAL_MIN", 10)),
  fastMode: bool("BRAIN_FAST_MODE", true),
  fastModeDepthThreshold: Math.min(1, Math.max(0, num("BRAIN_FAST_MODE_DEPTH_THRESHOLD", 0.65))),
  fastModeMaxTokens: Math.max(128, num("BRAIN_FAST_MODE_MAX_TOKENS", 768)),
  // Fable + Mythos upgrade.
  fastSalvage: bool("FAST_SALVAGE", true),
  fastSalvageScoreFloor: Math.min(1, Math.max(0, num("FAST_SALVAGE_SCORE_FLOOR", 0.25))),
  parallelReasoning: bool("PARALLEL_REASONING", false),
  parallelReasoningDrafts: Math.min(3, Math.max(2, num("PARALLEL_REASONING_DRAFTS", 2))),
  adaptiveDepth: bool("ADAPTIVE_DEPTH", false),
  adaptiveDepthWarmAt: Math.max(1, num("ADAPTIVE_DEPTH_WARM_AT", 20)),
  selfNarrative: bool("SELF_NARRATIVE", true),
  innerMonologue: bool("INNER_MONOLOGUE", true),
  narrativeGrounding: bool("NARRATIVE_GROUNDING", false),
  backupEnabled: bool("BACKUP_ENABLED", true),
  backupIntervalHours: Math.max(1, num("BACKUP_INTERVAL_HOURS", 24)),
  backupKeep: Math.max(1, num("BACKUP_KEEP", 7)),
};

export const REPO_ROOT_PATH = REPO_ROOT;
