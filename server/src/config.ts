import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// server/src → project root
const REPO_ROOT = resolve(__dirname, "..", "..");

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
  // Enable the P2P Civilization subsystem. Binds port 8788; start/stop is
  // tracked in the shutdown handler.
  civilizationEnabled: boolean;
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
  civilizationEnabled: bool("CIVILIZATION_ENABLED", false),
};

export const REPO_ROOT_PATH = REPO_ROOT;
