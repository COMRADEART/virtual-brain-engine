// One-off maintenance: repoint the seeded own-model connector at the renamed
// Ollama model "mango". Uses the production seam (ensureOwnModelConnector) so
// the enabled/default choices are preserved exactly as a re-serve would.
import { openDb } from "../src/db/sqlite.js";
import { getConnector } from "../src/db/repositories/connectors.js";
import { ensureOwnModelConnector } from "../src/connectors/registry.js";

openDb();
const before = getConnector("own-model");
console.log("before:", before ? { model: before.model, enabled: before.enabled, isDefault: before.isDefault } : null);
const after = ensureOwnModelConnector("mango");
console.log("after:", { model: after.model, enabled: after.enabled, isDefault: after.isDefault });
