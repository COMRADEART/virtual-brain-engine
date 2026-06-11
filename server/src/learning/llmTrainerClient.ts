// Typed HTTP client for the from-scratch LLM trainer on the Python worker
// sidecar (Learning Lab — Phase C). Same boundary contract as the perception
// client: the server MUST run with the worker down. Every method returns a
// structured status rather than throwing; an absent/old worker degrades to
// state:"unavailable" and the UI shows the honest "start the worker" hint.
//
// Corpus ownership: the Node side owns the SQLite DB, so it assembles the
// training corpus and POSTs it to the worker. The worker never reaches back
// into Node — keeps the dependency one-directional and avoids an auth hop.

import type { LlmGenerateResult, LlmTrainerStatus } from "../../../shared/learning.js";
import { CONFIG } from "../config.js";
import { exportMemoryCorpus } from "../db/repositories/memory.js";
import { broadcast } from "../ws/brainBus.js";
import { surfaceError } from "../util/diagnostics.js";

const BASE_URL = process.env.PERCEPTION_WORKER_URL ?? "http://127.0.0.1:8789";
const STATUS_TIMEOUT_MS = 500;
const START_TIMEOUT_MS = 10_000;
const GENERATE_TIMEOUT_MS = 60_000;
// Cap the corpus we ship to the worker. This guards against an accidentally
// huge DB, not an expected size — a well-used brain's corpus is now several
// million chars, so the cap sits above that.
const MAX_CORPUS_CHARS = 8_000_000;

function downStatus(message: string): LlmTrainerStatus {
  return {
    state: "unavailable",
    step: 0,
    totalSteps: 0,
    loss: null,
    valLoss: null,
    sample: null,
    vocabSize: null,
    params: null,
    corpusChars: null,
    device: null,
    checkpointPath: null,
    message,
    updatedAt: null,
  };
}

// The worker returns a superset/subset over time; normalise to our contract so
// a missing field never crashes the panel.
function normalize(raw: Partial<LlmTrainerStatus> & Record<string, unknown>): LlmTrainerStatus {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const validStates: LlmTrainerStatus["state"][] = ["idle", "running", "done", "error", "unavailable"];
  const state = validStates.includes(raw.state as LlmTrainerStatus["state"])
    ? (raw.state as LlmTrainerStatus["state"])
    : "idle";
  return {
    state,
    step: num(raw.step) ?? 0,
    totalSteps: num(raw.totalSteps) ?? 0,
    loss: num(raw.loss),
    valLoss: num(raw.valLoss),
    sample: typeof raw.sample === "string" ? raw.sample : null,
    vocabSize: num(raw.vocabSize),
    params: num(raw.params),
    corpusChars: num(raw.corpusChars),
    device: typeof raw.device === "string" ? raw.device : null,
    checkpointPath: typeof raw.checkpointPath === "string" ? raw.checkpointPath : null,
    message: typeof raw.message === "string" ? raw.message : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
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

/** Poll the trainer. Cheap (500ms cap) — safe while a Learning Lab panel is open. */
export async function getLlmTrainerStatus(): Promise<LlmTrainerStatus> {
  const r = await fetchJson<Record<string, unknown>>(
    "/train/status",
    { method: "GET" },
    STATUS_TIMEOUT_MS,
    "learning:llm-status",
    true, // a down trainer is expected, not a swallowed error
  );
  if (!r.ok) {
    return downStatus(
      "From-scratch LLM trainer offline. Start the worker (worker/main.py) with ML deps installed.",
    );
  }
  return normalize(r.data);
}

export interface StartTrainingOptions {
  steps?: number;
  force?: boolean;
}

/**
 * Assemble the brain's own memory corpus and hand it to the worker to train a
 * from-scratch GPT on. Returns the trainer's status (running) or a structured
 * "unavailable" if the worker is down. Refuses to start on an empty corpus.
 */
export async function startLlmTraining(opts: StartTrainingOptions = {}): Promise<LlmTrainerStatus> {
  const corpus = exportMemoryCorpus({
    maxChars: MAX_CORPUS_CHARS,
    englishOnly: CONFIG.trainEnglishMostly,
  });
  if (corpus.chars < 1000) {
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
    "/train/start",
    {
      method: "POST",
      body: JSON.stringify({
        corpus: corpus.text,
        steps: opts.steps,
        force: opts.force ?? false,
      }),
    },
    START_TIMEOUT_MS,
    "learning:llm-start",
  );
  if (!r.ok) {
    return downStatus(`Could not start trainer: ${r.error}`);
  }
  return normalize(r.data);
}

export interface GenerateOptions {
  prompt?: string;
  maxNewTokens?: number;
  temperature?: number;
}

/**
 * Sample from the persisted from-scratch brain model. Degrades to a structured
 * { ok:false } when the worker is down or no model has been trained yet —
 * never throws.
 */
export async function generateFromScratchLlm(opts: GenerateOptions = {}): Promise<LlmGenerateResult> {
  const r = await fetchJson<Record<string, unknown>>(
    "/train/generate",
    {
      method: "POST",
      body: JSON.stringify({
        prompt: opts.prompt ?? "",
        maxNewTokens: opts.maxNewTokens,
        temperature: opts.temperature,
      }),
    },
    GENERATE_TIMEOUT_MS,
    "learning:llm-generate",
    true, // worker down / not-yet-trained are expected states, not errors
  );
  if (!r.ok) {
    return { ok: false, text: null, latencyMs: null, params: null, device: null, error: r.error };
  }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ok: true,
    text: typeof r.data.text === "string" ? r.data.text : null,
    latencyMs: num(r.data.latencyMs),
    params: num(r.data.params),
    device: typeof r.data.device === "string" ? r.data.device : null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Training watcher — while a run is live, poll the worker and broadcast
// progress on the WS bus so the frontend's TrainingBar renders without
// polling. Singleton: starting it twice is a no-op.
// ---------------------------------------------------------------------------

const WATCH_INTERVAL_MS = 2000;
let watcher: NodeJS.Timeout | null = null;

export function ensureLlmTrainingWatcher(): void {
  if (watcher) return;
  watcher = setInterval(() => {
    void (async () => {
      const status = await getLlmTrainerStatus();
      if (status.state === "running") {
        broadcast({
          type: "llm-training",
          state: "running",
          step: status.step,
          totalSteps: status.totalSteps,
          loss: status.loss,
          params: status.params,
          device: status.device,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      // Terminal (done/error) or the worker vanished — emit one final frame
      // for real terminals, then stop watching either way.
      if (status.state === "done" || status.state === "error") {
        broadcast({
          type: "llm-training",
          state: status.state,
          step: status.step,
          totalSteps: status.totalSteps,
          loss: status.loss,
          params: status.params,
          device: status.device,
          timestamp: new Date().toISOString(),
        });
      }
      if (watcher) {
        clearInterval(watcher);
        watcher = null;
      }
    })();
  }, WATCH_INTERVAL_MS);
  // Never keep the process alive just to watch training.
  watcher.unref?.();
}

/** Selfcheck helper. */
export const LLM_TRAINER_BASE_URL = BASE_URL;
