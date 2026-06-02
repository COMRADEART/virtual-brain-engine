// Model Hub selfcheck. HERMETIC: throwaway DB via BRAIN_DB_PATH (set BEFORE
// importing config-dependent modules), no Ollama, no network. The risky core —
// multi-layer pull-progress aggregation — is pure and tested against a fixture
// shaped like Ollama's REAL /api/pull NDJSON (manifest → per-digest layers →
// success). The live `ollama pull` is the separate "done" gate (models:smoke).
//
// Run: npm --prefix server run models:selfcheck
//
// Asserts:
//   PullProgress — null while indeterminate (manifest); per-line completed does
//     NOT reset percent (cumulative across digests); a new layer joins the
//     denominator (percent dips, doesn't reset to 0); success → done + 100%;
//     a per-line error is captured.
//   resolveOllamaBaseUrl — falls back to the (local) default; returns the base
//     of a seeded LOCAL ollama row; returns null when the only ollama row is
//     NON-local (the defense-in-depth egress guard).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-modelcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
// Force LOCAL_ONLY off-irrelevant: resolveOllamaBaseUrl uses isLocalUrl directly.

const { openDb } = await import("../src/db/sqlite.js");
const { PullProgress, resolveOllamaBaseUrl } = await import("../src/connectors/ollamaModels.js");
const { upsertConnector } = await import("../src/db/repositories/connectors.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

// --- PullProgress: realistic multi-layer fixture ----------------------------
{
  const p = new PullProgress();
  p.update({ status: "pulling manifest" });
  check("percent is indeterminate during the manifest phase", p.percent() === null);

  p.update({ status: "pulling sha256:aaa", digest: "sha256:aaa", total: 1000, completed: 0 });
  p.update({ status: "pulling sha256:aaa", digest: "sha256:aaa", total: 1000, completed: 500 });
  check("percent reflects mid-layer progress", p.percent() === 0.5, `got ${p.percent()}`);

  p.update({ status: "pulling sha256:aaa", digest: "sha256:aaa", total: 1000, completed: 1000 });
  check("percent is 1.0 with only the first layer known", p.percent() === 1, `got ${p.percent()}`);

  // A NEW layer is announced (completed 0). The naive per-line bug would reset
  // to 0; the cumulative tracker reports 1000/4000 = 0.25 (dips, never resets).
  p.update({ status: "pulling sha256:bbb", digest: "sha256:bbb", total: 3000, completed: 0 });
  check("a new layer is cumulative (0.25), not a reset to 0", p.percent() === 0.25, `got ${p.percent()}`);

  p.update({ status: "pulling sha256:bbb", digest: "sha256:bbb", total: 3000, completed: 3000 });
  check("percent reaches 1.0 across all layers", p.percent() === 1, `got ${p.percent()}`);

  p.update({ status: "verifying sha256 digest" });
  p.update({ status: "writing manifest" });
  check("status tracks the latest phase", p.status === "writing manifest", `got "${p.status}"`);

  p.update({ status: "success" });
  check("success marks done", p.done === true);
  check("no error on a clean pull", p.error === null);
}
{
  const p = new PullProgress();
  p.update({ status: "pulling sha256:x", digest: "sha256:x", total: 10, completed: 5 });
  p.update({ error: "max retries exceeded" });
  check("a per-line error is captured", p.error === "max retries exceeded");
}

// --- resolveOllamaBaseUrl: local-only egress guard --------------------------
{
  // No ollama rows → falls back to the configured default (loopback) → non-null.
  check("falls back to the default local base when no rows exist", resolveOllamaBaseUrl() !== null);

  // A LOCAL ollama row is resolved to its base.
  upsertConnector({ id: "ollama-default", name: "Local Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3.2:3b", enabled: true, isDefault: true });
  check("resolves a seeded local ollama base", resolveOllamaBaseUrl() === "http://127.0.0.1:11434", `got ${resolveOllamaBaseUrl()}`);

  // Make the only ollama row NON-local (a public host — RFC1918 like 10/8 would
  // still count as local) → must resolve to null.
  upsertConnector({ id: "ollama-default", name: "Remote Ollama", kind: "ollama", baseUrl: "http://203.0.113.7:11434", model: "llama3.2:3b", enabled: true, isDefault: true });
  check("returns null when the only ollama base is non-local (egress guard)", resolveOllamaBaseUrl() === null, `got ${resolveOllamaBaseUrl()}`);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
