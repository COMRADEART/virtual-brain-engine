// Model Hub backend — talks to the LOCAL Ollama daemon's management API
// (/api/tags, /api/pull). Pull is Ollama-specific, so it lives here rather than
// on the generic Connector interface. The server only ever hits a loopback base
// (guarded by isLocalUrl); the egress is Ollama's own process pulling from its
// registry on an explicit user action.

import { CONFIG } from "../config.js";
import { listConnectors } from "../db/repositories/connectors.js";
import { isLocalUrl } from "../util/network.js";

// One NDJSON line from /api/pull. Ollama streams, per line:
//   {"status":"pulling manifest"}                              (no total)
//   {"status":"pulling <digest>","digest":"sha256:..","total":N,"completed":M}
//   ...repeated per LAYER, completed climbing to total...
//   {"status":"verifying sha256 digest"} {"status":"writing manifest"}
//   {"status":"success"}
export interface PullLine {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

// Aggregates progress across layers. A naive per-line `completed/total` resets
// to ~0 every time a new layer starts; instead we track per-digest and sum, so
// percent reflects the whole download. It still dips when a brand-new layer is
// first announced (its total joins the denominator before bytes arrive) — that's
// honest: the known total genuinely grew. Pure + deterministic (selfcheck target).
export class PullProgress {
  private readonly totals = new Map<string, number>();
  private readonly completed = new Map<string, number>();
  private lastStatus = "";
  private finished = false;
  private err: string | null = null;

  update(line: PullLine): void {
    if (line.error) {
      this.err = line.error;
      return;
    }
    if (typeof line.status === "string" && line.status.length > 0) {
      this.lastStatus = line.status;
    }
    if (line.digest && typeof line.total === "number") {
      this.totals.set(line.digest, line.total);
      this.completed.set(line.digest, typeof line.completed === "number" ? line.completed : 0);
    }
    if (line.status === "success") {
      this.finished = true;
    }
  }

  percent(): number | null {
    let total = 0;
    let done = 0;
    for (const v of this.totals.values()) total += v;
    for (const v of this.completed.values()) done += v;
    if (total === 0) {
      return null; // indeterminate — still in the manifest phase
    }
    return Math.min(1, done / total);
  }

  get status(): string {
    return this.lastStatus;
  }
  get done(): boolean {
    return this.finished;
  }
  get error(): string | null {
    return this.err;
  }
}

// Resolve the loopback Ollama daemon: prefer an enabled+ok ollama connector,
// then any enabled ollama row, then the configured default. Returns null when
// the resolved base is not local (defense-in-depth — pull must never egress to
// a non-loopback host).
export function resolveOllamaBaseUrl(): string | null {
  const ollamaRows = listConnectors().filter((c) => c.kind === "ollama" && c.baseUrl);
  const pick =
    ollamaRows.find((c) => c.enabled && c.state === "ok") ??
    ollamaRows.find((c) => c.enabled) ??
    ollamaRows[0];
  const base = (pick?.baseUrl ?? CONFIG.ollamaBaseUrl).replace(/\/$/, "");
  return isLocalUrl(base) ? base : null;
}

export async function listOllamaModels(base: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${base}/api/tags`, { signal });
  if (!res.ok) {
    throw new Error(`Ollama /api/tags returned ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
  return (data.models ?? [])
    .map((m) => m.name ?? m.model ?? "")
    .filter((n) => n.length > 0);
}

// Streams POST /api/pull, invoking onLine for each parsed NDJSON line. Throws on
// a transport failure; per-line `error` fields are surfaced via onLine and the
// caller's PullProgress.
export async function pullModel(
  base: string,
  name: string,
  onLine: (line: PullLine) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama /api/pull returned ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            onLine(JSON.parse(line) as PullLine);
          } catch {
            // skip a malformed line
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
