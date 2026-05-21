// Reproducible sanity check for the pure LTR model. No DB / network.
// Run: npm --prefix server run ranker:selfcheck
//
// Asserts, on seeded synthetic ground truth:
//   (1) mean log-loss strictly decreases after training, and
//   (2) every predictProb() output stays finite and within [0, 1] along the
//       whole training trajectory (catches divergence / NaN).

import {
  FEATURE_DIM,
  logLoss,
  predictProb,
  sgdStep,
  zeroWeights,
} from "../src/reasoning/rankerModel.js";

function mulberry32(seed: number): () => number {
  return () => {
    let v = (seed += 0x6d2b79f5);
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260515);
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// Hidden ground-truth weights the model must approximately recover.
const TRUE_W = [-0.5, 2.4, 1.1, 0.8, 0.6, -0.4, 0.3, -0.7];
if (TRUE_W.length !== FEATURE_DIM) {
  console.error(`selfcheck misconfigured: TRUE_W len ${TRUE_W.length} != ${FEATURE_DIM}`);
  process.exit(2);
}

function sample(): { x: number[]; y: number } {
  const x = [
    1,
    rng(),
    rng(),
    rng(),
    rng() < 0.5 ? 1 : 0,
    rng() < 0.5 ? 1 : 0,
    rng() < 0.5 ? 1 : 0,
    rng(),
  ];
  let z = 0;
  for (let i = 0; i < x.length; i += 1) z += TRUE_W[i] * x[i];
  const y = rng() < sigmoid(z) ? 1 : 0;
  return { x, y };
}

const train = Array.from({ length: 500 }, sample);
const test = Array.from({ length: 200 }, sample);

let weights = zeroWeights();
const startLoss = logLoss(weights, test);

let allProbsValid = true;
const EPOCHS = 40;
for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
  for (const { x, y } of train) {
    weights = sgdStep(weights, x, y, 0.05, 1e-4);
    const p = predictProb(weights, x);
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      allProbsValid = false;
    }
  }
}

const endLoss = logLoss(weights, test);

const lossImproved = endLoss < startLoss * 0.9;
const ok = lossImproved && allProbsValid;

console.log(
  JSON.stringify(
    {
      startLoss: Number(startLoss.toFixed(4)),
      endLoss: Number(endLoss.toFixed(4)),
      improvedBy: `${(((startLoss - endLoss) / startLoss) * 100).toFixed(1)}%`,
      lossImproved,
      allProbsValid,
      learnedWeights: weights.map((w) => Number(w.toFixed(3))),
      result: ok ? "PASS" : "FAIL",
    },
    null,
    2,
  ),
);

process.exit(ok ? 0 : 1);
