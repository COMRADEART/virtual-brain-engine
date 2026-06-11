// One-off: serve the finished own-model (worker reports state=done) — writes
// the Modelfile (TEMPLATE + num_predict), runs quantized `ollama create`, seeds
// the connector. The production serveOwnModel() path, nothing bespoke.
const { serveOwnModel } = await import("../src/learning/ownModelClient.js");
const { getConnector } = await import("../src/db/repositories/connectors.js");

const served = await serveOwnModel();
console.log(`served=${served.served} model=${served.modelName}`);
console.log(`message: ${served.message}`);
const conn = getConnector("own-model");
console.log(`connector: ${conn ? `model=${conn.model} enabled=${conn.enabled} default=${conn.isDefault}` : "MISSING"}`);
process.exit(served.served ? 0 : 1);
