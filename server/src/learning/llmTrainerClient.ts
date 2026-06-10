// Typed HTTP client for the from-scratch LLM trainer on the Python worker
// sidecar (Learning Lab — Phase C). Same boundary contract as the perception
// client: the server MUST run with the worker down. Every method returns a
// structured status rather than throwing; an absent/old worker degrades to
// state:"unavailable" and the UI shows the honest "start the worker" hint.
//
// Corpus ownership: the Node side owns the SQLite DB, so it assembles the
// training corpus and POSTs it to the worker. The worker never reaches back
// into Node — keeps the dependency one-directional and avoids an auth hop.

import type { LlmTrainerStatus } from "../../../shared/learning.js";
import { exportMemoryCorpus } from "../db/repositories/memory.js";
import { surfaceError } from "../util/diagnostics.js";

const BASE_URL = process.env.PERCEPTION_WORKER_URL ?? "http://127.0.0.1:8789";
const STATUS_TIMEOUT_MS = 500;
const START_TIMEOUT_MS = 10_000;
// Cap the corpus we ship to the worker. A personal brain's corpus is small;
// this is a guard against an accidentally huge DB, not an expected size.
const MAX_CORPUS_CHARS = 2_000_000;

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
  const corpus = exportMemoryCorpus({ maxChars: MAX_CORPUS_CHARS });
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

/** Selfcheck helper. */
export const LLM_TRAINER_BASE_URL = BASE_URL;
