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
// Cap the corpus we ship to the worker. This guards against an accidentally
// huge DB, not an expected size — a well-used brain's corpus is now several
// million chars, so the cap sits above that.
const MAX_CORPUS_CHARS = 8_000_000;
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
  const corpus = exportMemoryCorpus({
    maxChars: MAX_CORPUS_CHARS,
    englishOnly: CONFIG.trainEnglishMostly,
  });
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

// Ollama Go chat template for the served model — the canonical Qwen2.5 ChatML
// template from Ollama's library, INCLUDING the <tool_call> protocol. The GGUF
// embeds Qwen-BASE's jinja template, which has no tools section, so Ollama
// rejects any request carrying `tools` with a 400 ("does not support tools").
// Writing this TEMPLATE into the Modelfile makes the served model accept tool
// definitions (external clients like IDE agents send them). Honest caveat: a
// CPT-adapted base model ACCEPTS tools but was never trained to call them well.
const QWEN_CHATML_TEMPLATE = `{{- if .Messages }}
{{- if or .System .Tools }}<|im_start|>system
{{- if .System }}
{{ .System }}
{{- end }}
{{- if .Tools }}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{{- range .Tools }}
{"type": "function", "function": {{ .Function }}}
{{- end }}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>
{{- end }}<|im_end|>
{{ end }}
{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 }}
{{- if eq .Role "user" }}<|im_start|>user
{{ .Content }}<|im_end|>
{{ else if eq .Role "assistant" }}<|im_start|>assistant
{{ if .Content }}{{ .Content }}
{{- else if .ToolCalls }}<tool_call>
{{ range .ToolCalls }}{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
{{ end }}</tool_call>
{{- end }}{{ if not $last }}<|im_end|>
{{ end }}
{{- else if eq .Role "tool" }}<|im_start|>user
<tool_response>
{{ .Content }}
</tool_response><|im_end|>
{{ end }}
{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant
{{ end }}
{{- end }}
{{- else }}
{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ end }}{{ .Response }}{{ if .Response }}<|im_end|>{{ end }}`;

/** Modelfile contents for serving: FROM + the tools-capable ChatML template +
 * a default generation ceiling. Exported for the selfcheck.
 *
 * Deliberately NO `PARAMETER stop` line: on Ollama 0.30.x a model-level stop
 * string makes the runner ignore num_predict and decode until the context
 * fills (measured: a 20-token-capped request ran past 10k tokens; the
 * identical build minus the stop param respected the cap).
 *
 * `PARAMETER num_predict` is the substitute guard (measured safe — caps at the
 * value, request options still override): a CPT-adapted BASE model never emits
 * the ChatML turn-end token, so without a ceiling any client that omits
 * max_tokens gets an answer that rambles to the context limit. */
const DEFAULT_NUM_PREDICT = 1024;

export function buildModelfile(fromPath: string): string {
  return `FROM ${fromPath}\nTEMPLATE """${QWEN_CHATML_TEMPLATE}"""\nPARAMETER num_predict ${DEFAULT_NUM_PREDICT}\n`;
}

// Quantizations `ollama create --quantize` accepts. q4_K_M is what Ollama's own
// library models ship with — ~4x smaller than F16 at near-identical quality, so
// the compressed model behaves like the uncompressed one.
const QUANTIZE_LEVELS = ["q4_K_M", "q4_K_S", "q8_0"] as const;
const DEFAULT_QUANTIZE = "q4_K_M";

/**
 * Resolve the quantization to request from `ollama create`, or null for none.
 * Pure (env + source-path in, level out) so the selfcheck can cover it.
 * `--quantize` requires an F16/F32 GGUF source, so the safetensors-dir fallback
 * path never quantizes. OWN_MODEL_QUANTIZE overrides: a known level forces it,
 * "off"/"f16"/"none" disables, anything else falls back to the default.
 */
export function resolveQuantize(
  source: { ggufPath: string | null },
  env: string | undefined = process.env.OWN_MODEL_QUANTIZE,
): string | null {
  if (!source.ggufPath) return null;
  const want = (env ?? "").trim();
  if (["off", "f16", "none", "false"].includes(want.toLowerCase())) return null;
  const match = QUANTIZE_LEVELS.find((l) => l.toLowerCase() === want.toLowerCase());
  return match ?? DEFAULT_QUANTIZE;
}

function runOllamaCreate(
  name: string,
  modelfilePath: string,
  quantize: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = ["create", name, "-f", modelfilePath];
  if (quantize) args.push("--quantize", quantize);
  return new Promise((resolve) => {
    execFile(
      "ollama",
      args,
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
    await writeFile(modelfilePath, buildModelfile(fromPath), "utf8");
  } catch (err) {
    surfaceError("learning:ownmodel-serve", err);
    return { ...status, message: `Could not write Modelfile: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Compress on import: quantize the F16 GGUF (default q4_K_M — what Ollama's
  // own library models ship as, ~4x smaller at near-identical quality). An old
  // Ollama without --quantize falls back to the uncompressed import rather than
  // failing the serve.
  const quantize = resolveQuantize({ ggufPath: status.ggufPath });
  let created = await runOllamaCreate(name, modelfilePath, quantize);
  let quantizeNote = quantize ? ` (quantized ${quantize})` : "";
  if (!created.ok && quantize) {
    created = await runOllamaCreate(name, modelfilePath, null);
    quantizeNote = created.ok ? " (quantization unsupported by this Ollama — imported uncompressed)" : "";
  }
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
    message: `Served as Ollama model "${name}"${quantizeNote} and seeded an opt-in connector. Enable it in the connector picker to use it.`,
  };
}

/** Selfcheck helpers. */
export const OWN_MODEL_BASE_URL = BASE_URL;
export const OWN_MODEL_OLLAMA_BASE = CONFIG.ollamaBaseUrl;
