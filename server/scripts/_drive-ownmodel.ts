// Runtime driver for the brain's own-model pipeline (Plan Civil "verification
// floor" — the live check the hermetic selfcheck can't do). Exercises the REAL
// Node path against the REAL brain DB + a running worker:
//   startOwnModelTraining (real corpus) -> poll getOwnModelStatus -> serveOwnModel
// then prints the seeded connector. Untracked, _-prefixed; not a gate step.
//
// Prereq: worker running on 127.0.0.1:8789 with CUDA torch + transformers + peft.
// Run: npm --prefix server exec tsx scripts/_drive-ownmodel.ts

const { startOwnModelTraining, getOwnModelStatus, serveOwnModel } = await import(
  "../src/learning/ownModelClient.js"
);
const { getConnector } = await import("../src/db/repositories/connectors.js");

const STEPS = Number(process.env.OWN_MODEL_STEPS ?? 250);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`[drive] starting own-model training (${STEPS} steps) on the real corpus…`);
const started = await startOwnModelTraining({ steps: STEPS });
console.log(`[drive] start -> state=${started.state} msg=${started.message ?? ""}`);
if (started.state !== "running") {
  console.log("[drive] trainer did not start running — aborting.");
  process.exit(1);
}

let last = "";
let downStreak = 0;
for (;;) {
  await sleep(5000);
  const s = await getOwnModelStatus();
  const line = `state=${s.state} step=${s.step}/${s.totalSteps} loss=${s.loss ?? "—"} device=${s.device ?? "—"}`;
  if (line !== last) {
    console.log(`[drive] ${line}`);
    last = line;
  }
  if (s.state === "done") break;
  if (s.state === "error") {
    console.log(`[drive] training ended: error — ${s.message ?? ""}`);
    process.exit(1);
  }
  // The merge step can hold the GIL past the 500ms status-probe cap, which
  // reads as a transient "unavailable" — only give up after a sustained outage.
  if (s.state === "unavailable") {
    downStreak++;
    if (downStreak >= 6) {
      console.log(`[drive] worker unreachable for ${downStreak} consecutive polls — giving up.`);
      process.exit(1);
    }
  } else {
    downStreak = 0;
  }
}

console.log("[drive] training done — serving via ollama create + connector seed…");
const served = await serveOwnModel();
console.log(`[drive] serve -> served=${served.served} model=${served.modelName} msg=${served.message ?? ""}`);

const conn = getConnector("own-model");
console.log(
  `[drive] connector own-model: ${conn ? `model=${conn.model} enabled=${conn.enabled} default=${conn.isDefault}` : "MISSING"}`,
);
console.log(served.served && conn ? "DRIVE_OK" : "DRIVE_INCOMPLETE");
process.exit(served.served && conn ? 0 : 1);
