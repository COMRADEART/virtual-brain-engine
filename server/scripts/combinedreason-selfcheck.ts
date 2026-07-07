// Combined reasoning+error selfcheck. HERMETIC: a SCRIPTED stub connector stands
// in for the LLM (no network, no Ollama), and the DB is a throwaway temp file.
//
// Run: npm --prefix server run combinedreason:selfcheck
//
// Asserts:
//   - combinedReasoningError=true (default) merges reasoning + error into ONE
//     connector.send call when the model returns both plan and error fields.
//   - If the combined response omits error fields, the error step falls back to
//     its own call — TWO send calls total.
//   - The error event detail carries "(combined)" when the report was reused.
//   - The reasoning step still completes and the pipeline reaches response.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-combinedreason-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.LOCAL_ONLY = "true";
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const { runPipeline } = await import("../src/reasoning/pipeline.js");
const { upsertConnector } = await import("../src/db/repositories/connectors.js");
const { getConnectorInstance } = await import("../src/connectors/registry.js");

type Connector = import("../src/connectors/Connector.js").Connector;
type PipelineEvent = import("../../shared/pipeline.js").PipelineEvent;

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

// Build a connector whose send() returns scripted JSON responses and whose
// stream() yields a minimal answer. embed() returns a correctly-dim zero vector.
// Responses are keyed by the system prompt so concurrent calls (project rerank
// + reasoning + error) consume the right queue instead of racing on one global
// list.
function scriptedConnector(queues: {
  project?: string[];
  reasoning?: string[];
  error?: string[];
}): { instance: Connector; calls: string[] } {
  const calls: string[] = [];
  const counters = { project: 0, reasoning: 0, error: 0 };
  function next(category: keyof typeof counters): string {
    const queue = queues[category];
    if (!queue || queue.length === 0) return "{}";
    const idx = Math.min(counters[category], queue.length - 1);
    return queue[idx];
  }
  const instance: Connector = {
    descriptor: {
      id: "combinedreason-stub",
      name: "combinedreason-stub",
      kind: "ollama",
      enabled: true,
      state: "ok",
      isLocal: true,
      createdAt: "",
      updatedAt: "",
    },
    async listModels() {
      return [];
    },
    async send(prompt, opts) {
      const system = opts?.system ?? "";
      let category: keyof typeof counters = "reasoning";
      if (system.includes("project cortex")) category = "project";
      else if (system.includes("error-detection center") && !system.includes("reasoning cortex")) category = "error";
      calls.push(`${category}:${opts?.format === "json" ? "json" : "text"}`);
      counters[category]++;
      const r = next(category);
      return r;
    },
    async *stream() {
      yield "The answer is 42.";
    },
    async embed() {
      return new Array(CONFIG.embeddingDim).fill(0);
    },
    async test() {
      return { ok: true };
    },
  };
  return { instance, calls };
}

function seedStub(instance: Connector): void {
  upsertConnector({
    id: "combinedreason-stub",
    name: "combinedreason-stub",
    kind: "agent",
    enabled: true,
    isDefault: true,
  });
  const cached = getConnectorInstance("combinedreason-stub");
  if (!cached) throw new Error("failed to seed stub connector");
  // Replace the cached AgentConnector's methods with the scripted ones.
  Object.assign(cached, instance);
}

async function collectRun(
  prompt: string,
  queues: { project?: string[]; reasoning?: string[]; error?: string[] },
): Promise<{ events: PipelineEvent[]; calls: string[] }> {
  const { instance, calls } = scriptedConnector(queues);
  seedStub(instance);
  CONFIG.combinedReasoningError = true;
  CONFIG.parallelReasoning = false;
  CONFIG.multiQueryRag = false; // keep send-call counting deterministic
  CONFIG.fastMode = false; // raise the depth gate so the test query takes the full route

  const events: PipelineEvent[] = [];
  await runPipeline({ prompt }, (ev) => events.push(ev));
  return { events, calls };
}

function step(events: PipelineEvent[], stepName: string, status: string): PipelineEvent | undefined {
  return events.find((e) => e.step === stepName && e.status === status);
}

// ── Case 1: combined response includes error fields ─────────────────────────
{
  const { events, calls } = await collectRun("Explain how neural networks work, and compare them to symbolic AI approaches", {
    reasoning: [
      JSON.stringify({
        plan: "Look up the canonical answer.",
        openQuestions: [],
        contradictions: [],
        missing: [],
        confidence: 0.95,
      }),
    ],
  });
  check("combined: reasoning completes", Boolean(step(events, "reasoning", "complete")));
  const errorEv = step(events, "error", "complete");
  check("combined: error completes", Boolean(errorEv));
  check("combined: error detail flags combined", errorEv?.detail?.includes("(combined)") ?? false, errorEv?.detail);
  check("combined: only one reasoning send", calls.filter((c) => c === "reasoning:json").length === 1, `calls=${calls.join(",")}`);
  check("combined: zero error sends", calls.filter((c) => c === "error:json").length === 0, `calls=${calls.join(",")}`);
  check("combined: pipeline reaches response", Boolean(step(events, "response", "complete")));
}

// ── Case 2: combined response omits error fields → fallback ─────────────────
{
  const { events, calls } = await collectRun("Explain how neural networks work, and compare them to symbolic AI approaches", {
    reasoning: [
      JSON.stringify({
        plan: "Look up the canonical answer.",
        openQuestions: [],
      }),
    ],
    error: [
      JSON.stringify({
        contradictions: [],
        missing: [],
        confidence: 0.8,
      }),
    ],
  });
  check("fallback: reasoning completes", Boolean(step(events, "reasoning", "complete")));
  const errorEv = step(events, "error", "complete");
  check("fallback: error completes", Boolean(errorEv));
  check("fallback: error detail does NOT flag combined", !errorEv?.detail?.includes("(combined)"), errorEv?.detail);
  check("fallback: one reasoning send", calls.filter((c) => c === "reasoning:json").length === 1, `calls=${calls.join(",")}`);
  check("fallback: one error send", calls.filter((c) => c === "error:json").length === 1, `calls=${calls.join(",")}`);
}

// ── Case 3: combined response is unparseable → plain reasoning fallback ─────
{
  const { events, calls } = await collectRun("Explain how neural networks work, and compare them to symbolic AI approaches", {
    reasoning: [
      "this is not json",
      JSON.stringify({
        plan: "Look up the canonical answer.",
        openQuestions: [],
      }),
    ],
    error: [
      JSON.stringify({
        contradictions: [],
        missing: [],
        confidence: 0.7,
      }),
    ],
  });
  check("unparseable: reasoning completes", Boolean(step(events, "reasoning", "complete")));
  check("unparseable: error completes", Boolean(step(events, "error", "complete")));
  check(
    "unparseable: at least one reasoning and one error send",
    calls.filter((c) => c === "reasoning:json").length >= 1 && calls.filter((c) => c === "error:json").length >= 1,
    `calls=${calls.join(",")}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll combined-reasoning checks passed");
