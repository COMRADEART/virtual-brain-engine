// Typed HTTP client for the brain's OWN-model trainer on the Python worker
// sidecar (Learning Lab — Phase D). Same boundary contract as the perception /
// from-scratch-LLM clients: the server MUST run with the worker down. Every
// method returns a structured status rather than throwing; an absent/old worker
// degrades to state:"unavailable".
//
// Corpus ownership: the Node side owns the SQLite DB, so it assembles the
// training corpus and POSTs it to the worker. Serving is also Node-side — once
// the worker reports a merged model dir, `serveOwnModel()` runs `ollama create`
// against it and seeds an opt-in connector, keeping all Ollama + connector logic
// where it belongs.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OwnModelStatus } from "../../../shared/learning.js";
import { exportMemoryCorpus } from "../db/repositories/memory.js";
import { ensureOwnModelConnector } from "../connectors/registry.js";
import { CONFIG } from "../config.js";
import { surfaceError } from "../util/diagnostics.js";

const BASE_URL = process.env.PERCEPTION_WORKER_URL ?? "http://127.0.0.1:8789";
const STATUS_TIMEOUT_MS = 500;
const START_TIMEOUT_MS = 10_000;
// `ollama create` from a safetensors dir converts + imports the weights, which
// can take a while for a 0.5B model — give it room.
const OLLAMA_CREATE_TIMEOUT_MS = 600_000;
// Cap the corpus we ship to the worker. A personal brain's corpus is small;
// this guards against an accidentally huge DB, not an expected size.
const MAX_CORPUS_CHARS = 2_000_000;
const MIN_CORPUS_CHARS = 1000;

function downStatus(message: string): OwnModelStatus {
  return {
    state: "unavailable",
    step: 0,
    totalSteps: 0,
    loss: null,
    baseModel: null,
    outputDir: null,
    ggufPath: null,
    modelName: null,
    served: false,
    corpusChars: null,
    trainableParams: null,
    device: null,
    message,
    updatedAt: null,
  };
}

// The worker returns a superset/subset over time; normalise to our contract so
// a missing field never crashes a consumer.
function normalize(raw: Partial<OwnModelStatus> & Record<string, unknown>): OwnModelStatus {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const validStates: OwnModelStatus["state"][] = [
    "idle",
    "running",
    "merging",
    "done",
    "error",
    "unavailable",
  ];
  const state = validStates.includes(raw.state as OwnModelStatus["state"])
    ? (raw.state as OwnModelStatus["state"])
    : "idle";
  return {
    state,
    step: num(raw.step) ?? 0,
    totalSteps: num(raw.totalSteps) ?? 0,
    loss: num(raw.loss),
    baseModel: str(raw.baseModel),
    outputDir: str(raw.outputDir),
    ggufPath: str(raw.ggufPath),
    modelName: str(raw.modelName),
    served: raw.served === true,
    corpusChars: num(raw.corpusChars),
    trainableParams: num(raw.trainableParams),
    device: str(raw.device),
    message: str(raw.message),
    updatedAt: str(raw.updatedAt),
  };
}

async function fetchJson<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  source: string,
  quiet = false,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        // not JSON — keep raw text
      }
      if (!quiet) surfaceError(source, new Error(`HTTP ${res.status}: ${detail}`));
      return { ok: false, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    if (!quiet) surfaceError(source, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll the own-model trainer. Cheap (500ms cap) — safe while a panel is open. */
export async function getOwnModelStatus(): Promise<OwnModelStatus> {
  const r = await fetchJson<Record<string, unknown>>(
    "/ownmodel/status",
    { method: "GET" },
    STATUS_TIMEOUT_MS,
    "learning:ownmodel-status",
    true, // a down trainer is expected, not a swallowed error
  );
  if (!r.ok) {
    return downStatus(
      "Own-model trainer offline. Start the worker (worker/main.py) with ML deps installed.",
    );
  }
  return normalize(r.data);
}

export interface StartOwnModelOptions {
  steps?: number;
  baseModel?: string;
  force?: boolean;
}

/**
 * Assemble the brain's own memory corpus and hand it to the worker to LoRA
 * continued-pretrain a base model on. Returns the trainer's status (running) or
 * a structured "unavailable"/"error" if the worker is down or the corpus is too
 * small.
 */
export async function startOwnModelTraining(
  opts: StartOwnModelOptions = {},
): Promise<OwnModelStatus> {
  const corpus = exportMemoryCorpus({ maxChars: MAX_CORPUS_CHARS });
  if (corpus.chars < MIN_CORPUS_CHARS) {
    return {
      ...downStatus(
        `Corpus too small to train (${corpus.chars} chars from ${corpus.documents} memories). ` +
          "Use the brain more — ask questions, scan a project — then try again.",
      ),
      state: "error",
      corpusChars: corpus.chars,
    };
  }
  const r = await fetchJson<Record<string, unknown>>(
    "/ownmodel/start",
    {
      method: "POST",
      body: JSON.stringify({
        corpus: corpus.text,
        steps: opts.steps,
        baseModel: opts.baseModel,
        force: opts.force ?? false,
      }),
    },
    START_TIMEOUT_MS,
    "learning:ownmodel-start",
  );
  if (!r.ok) {
    return downStatus(`Could not start own-model trainer: ${r.error}`);
  }
  return normalize(r.data);
}

function runOllamaCreate(name: string, modelfilePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      "ollama",
      ["create", name, "-f", modelfilePath],
      { timeout: OLLAMA_CREATE_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: stderr?.toString().trim() || err.message });
        } else {
          resolve({ ok: true });
        }
      },
    );
  });
}

/**
 * Import the worker's merged model dir into Ollama and seed it as an opt-in
 * connector. Only proceeds when the worker reports state:"done" with a real
 * output dir — otherwise refuses without touching Ollama. Failure-isolated: an
 * `ollama create` error degrades to a structured status, never throws.
 */
export async function serveOwnModel(): Promise<OwnModelStatus> {
  const status = await getOwnModelStatus();
  if (status.state !== "done" || !status.outputDir || !status.modelName) {
    return {
      ...status,
      message:
        status.message ??
        "No finished own-model to serve yet. Train one first (POST /api/learning/ownmodel/start).",
    };
  }

  const name = status.modelName;
  const modelfilePath = join(status.outputDir, "Modelfile");
  // Prefer the exported GGUF. `ollama create FROM <safetensors-dir>` mis-imports
  // transformers-5.x output (the model decodes to a single repeated token), so
  // the worker exports a GGUF and we import THAT — the robust path. Fall back to
  // the dir only if no GGUF was produced (older run / export failure).
  const source = status.ggufPath ?? status.outputDir;
  // The Ollama server resolves the `FROM` path from ITS cwd, so it must be
  // absolute (the trainer returns absolute paths). Forward slashes are required
  // even on Windows — a backslashed path is mis-parsed by the Modelfile reader
  // (proven by the serving spike).
  const fromPath = source.replace(/\\/g, "/");
  try {
    await writeFile(modelfilePath, `FROM ${fromPath}\n`, "utf8");
  } catch (err) {
    surfaceError("learning:ownmodel-serve", err);
    return { ...status, message: `Could not write Modelfile: ${err instanceof Error ? err.message : String(err)}` };
  }

  const created = await runOllamaCreate(name, modelfilePath);
  if (!created.ok) {
    surfaceError("learning:ownmodel-serve", new Error(created.error));
    return { ...status, served: false, message: `ollama create failed: ${created.error}` };
  }

  // Seed the connector — disabled + non-default, so a tiny-corpus adaptation
  // never silently becomes the model /api/ask uses.
  ensureOwnModelConnector(name);
  return {
    ...status,
    served: true,
    message: `Served as Ollama model "${name}" and seeded an opt-in connector. Enable it in the connector picker to use it.`,
  };
}

/** Selfcheck helpers. */
export const OWN_MODEL_BASE_URL = BASE_URL;
export const OWN_MODEL_OLLAMA_BASE = CONFIG.ollamaBaseUrl;
