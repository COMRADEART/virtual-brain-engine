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
  adaptiveController: bool("ADAPTIVE_CONTROLLER", false),
  banditWarmAt: Math.max(1, num("BANDIT_WARM_AT", 30)),
  agentMaxRounds: Math.min(50, Math.max(1, num("AGENT_MAX_ROUNDS", 12))),
  agentConfirmMode: oneOf("AGENT_CONFIRM_MODE", ["ask", "scope", "safe-only"] as const, "ask"),
  agentTriage: bool("AGENT_TRIAGE", true),
  githubToken: str("GITHUB_TOKEN", ""),
  githubMinStars: Math.max(1, num("GITHUB_MIN_STARS", 1000)),
  githubMaxRepos: Math.min(50, Math.max(1, num("GITHUB_MAX_REPOS", 10))),
};

export const REPO_ROOT_PATH = REPO_ROOT;
