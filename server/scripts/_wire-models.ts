// One-off maintenance: wire the user's chosen model roles.
//   1. Brain communication (/api/ask + agent answers) → qwen3.5:latest, by
//      setting the default Ollama connector's chat model (same logic as
//      POST /api/models/select, minus the live re-probe — boot probes anyway).
//      (qwen3.6 was the first choice but cannot load on this machine: 23GB
//      model vs 6GB GPU → Ollama OOMs with a 500 after minutes of retrying.)
//   2. Mango (the brain's own LoRA-trained model) → the "fast" Model Hub
//      profile, so the MoE router sends shallow/quick-lookup queries to it
//      while everything else stays on qwen3.5.
import { openDb } from "../src/db/sqlite.js";
import {
  getDefaultConnector,
  listConnectors,
  upsertConnector,
} from "../src/db/repositories/connectors.js";
import { getAssignments, setAssignment } from "../src/reasoning/modelRouting.js";

const CHAT_MODEL = "qwen3.5:latest";
const FAST_MODEL = "mango:latest";

openDb();

const def = getDefaultConnector();
const target = def && def.kind === "ollama" ? def : listConnectors().find((c) => c.kind === "ollama");
if (!target) {
  console.error("no Ollama connector found — boot the server once first");
  process.exit(1);
}
console.log("chat model before:", { id: target.id, model: target.model, isDefault: target.isDefault });
const updated = upsertConnector({
  id: target.id,
  name: target.name,
  kind: target.kind,
  baseUrl: target.baseUrl,
  model: CHAT_MODEL,
  embeddingModel: target.embeddingModel,
  enabled: true,
  isDefault: true,
});
console.log("chat model after:", { id: updated.id, model: updated.model, isDefault: updated.isDefault });

console.log("profile assignments before:", getAssignments());
const next = setAssignment("fast", FAST_MODEL);
console.log("profile assignments after:", next);
