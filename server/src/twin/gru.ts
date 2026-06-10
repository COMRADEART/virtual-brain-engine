// Digital Twin GRU sequence-predictor — PURE, DETERMINISTIC, dependency-free.
// No torch, no native deps, no DB, no `os`. A tiny single-layer GRU for
// univariate time-series, trained online with truncated BPTT + Adam over a
// z-score-normalized copy of the series. Seeded with mulberry32 so the same
// (series, cfg) always yields byte-identical output.
//
// Why this exists: `predictiveModel.ts` is OLS-only. OLS fits a straight line
// through a periodic series (a sine wave averages to a flat line at the mean),
// so its forecast error on oscillating loads is large (~30/√2 ≈ 21 for a
// 30-amplitude sine). A GRU that learns the short recurrence of a periodic
// series beats that. This module is the `gruForecast()` path the
// predictiveModel header seam documents.
//
// Standard GRU equations (per step t, scalar input x_t, hidden vector h):
//   z = σ(Wz·x + Uz·h + bz)            update gate
//   r = σ(Wr·x + Ur·h + br)            reset gate
//   c = tanh(Wc·x + Uc·(r⊙h) + bc)     candidate
//   h' = (1 - z)⊙h + z⊙c               new hidden
//   y = Wo·h' + bo                     scalar readout (one-step-ahead next value)

export interface GruConfig {
  hiddenSize?: number;
  epochs?: number;
  lr?: number;
  seed?: number;
}

export interface TrainedGru {
  hiddenSize: number;
  // Input→gate weights (length hiddenSize each).
  Wz: number[];
  Wr: number[];
  Wc: number[];
  // Recurrent gate weights (hiddenSize × hiddenSize, row-major).
  Uz: number[];
  Ur: number[];
  Uc: number[];
  // Gate biases (length hiddenSize each).
  bz: number[];
  br: number[];
  bc: number[];
  // Readout (hiddenSize → scalar).
  Wo: number[];
  bo: number;
  // Normalization stats (z-score) used to map inputs in and outputs out.
  mean: number;
  std: number;
}

const DEFAULTS = {
  hiddenSize: 8,
  epochs: 400,
  lr: 0.01,
  seed: 1337,
} as const;

/** Deterministic PRNG (matches the codebase mulberry32 used elsewhere). */
function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

// Small symmetric init in (-scale, scale). Seeded => deterministic.
function randVec(rng: () => number, n: number, scale: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * scale;
  return out;
}

interface StepCache {
  x: number; // normalized input at this step
  hPrev: number[];
  z: number[];
  r: number[];
  c: number[]; // candidate (tanh output)
  rh: number[]; // r ⊙ hPrev
  h: number[]; // new hidden
}

/**
 * Forward pass over a normalized series. Returns the per-step caches (for BPTT)
 * and the readout prediction at each step (one-step-ahead, normalized space).
 */
function forwardSequence(
  m: TrainedGru,
  xs: number[],
): { caches: StepCache[]; preds: number[] } {
  const H = m.hiddenSize;
  let h = zeros(H);
  const caches: StepCache[] = [];
  const preds: number[] = [];
  for (let t = 0; t < xs.length; t++) {
    const x = xs[t];
    const z = zeros(H);
    const r = zeros(H);
    const rh = zeros(H);
    const c = zeros(H);
    const hNew = zeros(H);
    for (let i = 0; i < H; i++) {
      let zPre = m.Wz[i] * x + m.bz[i];
      let rPre = m.Wr[i] * x + m.br[i];
      for (let j = 0; j < H; j++) {
        zPre += m.Uz[i * H + j] * h[j];
        rPre += m.Ur[i * H + j] * h[j];
      }
      z[i] = sigmoid(zPre);
      r[i] = sigmoid(rPre);
    }
    for (let i = 0; i < H; i++) rh[i] = r[i] * h[i];
    for (let i = 0; i < H; i++) {
      let cPre = m.Wc[i] * x + m.bc[i];
      for (let j = 0; j < H; j++) cPre += m.Uc[i * H + j] * rh[j];
      c[i] = Math.tanh(cPre);
      hNew[i] = (1 - z[i]) * h[i] + z[i] * c[i];
    }
    let y = m.bo;
    for (let i = 0; i < H; i++) y += m.Wo[i] * hNew[i];
    caches.push({ x, hPrev: h, z, r, c, rh, h: hNew });
    preds.push(y);
    h = hNew;
  }
  return { caches, preds };
}

interface Grads {
  Wz: number[];
  Wr: number[];
  Wc: number[];
  Uz: number[];
  Ur: number[];
  Uc: number[];
  bz: number[];
  br: number[];
  bc: number[];
  Wo: number[];
  bo: number;
}

function zeroGrads(H: number): Grads {
  return {
    Wz: zeros(H),
    Wr: zeros(H),
    Wc: zeros(H),
    Uz: zeros(H * H),
    Ur: zeros(H * H),
    Uc: zeros(H * H),
    bz: zeros(H),
    br: zeros(H),
    bc: zeros(H),
    Wo: zeros(H),
    bo: 0,
  };
}

/**
 * Truncated BPTT for one full forward pass. Targets `ts[t]` is the value the
 * model should predict at step t (one-step-ahead, normalized). Accumulates
 * gradients across all supervised steps into `g`; returns the summed MSE loss.
 */
function backward(
  m: TrainedGru,
  caches: StepCache[],
  preds: number[],
  ts: Array<number | null>,
  g: Grads,
): number {
  const H = m.hiddenSize;
  let loss = 0;
  let dhNext = zeros(H); // gradient flowing back into h[t] from step t+1
  for (let t = caches.length - 1; t >= 0; t--) {
    const cache = caches[t];
    const target = ts[t];
    const dh = dhNext.slice();
    if (target !== null) {
      const err = preds[t] - target; // dL/dy
      loss += 0.5 * err * err;
      // Readout grads + push error into h[t].
      g.bo += err;
      for (let i = 0; i < H; i++) {
        g.Wo[i] += err * cache.h[i];
        dh[i] += err * m.Wo[i];
      }
    }
    // Backprop through h = (1 - z)⊙hPrev + z⊙c.
    const dz = zeros(H);
    const dc = zeros(H);
    const dhPrev = zeros(H);
    for (let i = 0; i < H; i++) {
      dz[i] = dh[i] * (cache.c[i] - cache.hPrev[i]);
      dc[i] = dh[i] * cache.z[i];
      dhPrev[i] += dh[i] * (1 - cache.z[i]);
    }
    // Candidate: c = tanh(cPre), cPre = Wc·x + Uc·(r⊙hPrev) + bc.
    const dcPre = zeros(H);
    const drh = zeros(H);
    for (let i = 0; i < H; i++) {
      dcPre[i] = dc[i] * (1 - cache.c[i] * cache.c[i]);
      g.Wc[i] += dcPre[i] * cache.x;
      g.bc[i] += dcPre[i];
      for (let j = 0; j < H; j++) {
        g.Uc[i * H + j] += dcPre[i] * cache.rh[j];
        drh[j] += dcPre[i] * m.Uc[i * H + j];
      }
    }
    // rh = r ⊙ hPrev.
    const dr = zeros(H);
    for (let i = 0; i < H; i++) {
      dr[i] = drh[i] * cache.hPrev[i];
      dhPrev[i] += drh[i] * cache.r[i];
    }
    // Gates z, r: σ' = s·(1-s). cPre uses h via rh (handled above); z,r use
    // hPrev directly through Uz/Ur.
    const dzPre = zeros(H);
    const drPre = zeros(H);
    for (let i = 0; i < H; i++) {
      dzPre[i] = dz[i] * cache.z[i] * (1 - cache.z[i]);
      drPre[i] = dr[i] * cache.r[i] * (1 - cache.r[i]);
      g.Wz[i] += dzPre[i] * cache.x;
      g.bz[i] += dzPre[i];
      g.Wr[i] += drPre[i] * cache.x;
      g.br[i] += drPre[i];
    }
    for (let i = 0; i < H; i++) {
      for (let j = 0; j < H; j++) {
        g.Uz[i * H + j] += dzPre[i] * cache.hPrev[j];
        g.Ur[i * H + j] += drPre[i] * cache.hPrev[j];
        dhPrev[j] += dzPre[i] * m.Uz[i * H + j];
        dhPrev[j] += drPre[i] * m.Ur[i * H + j];
      }
    }
    dhNext = dhPrev;
  }
  return loss;
}

// Adam optimizer state (one slot per parameter group).
interface AdamState {
  mWz: number[]; vWz: number[];
  mWr: number[]; vWr: number[];
  mWc: number[]; vWc: number[];
  mUz: number[]; vUz: number[];
  mUr: number[]; vUr: number[];
  mUc: number[]; vUc: number[];
  mbz: number[]; vbz: number[];
  mbr: number[]; vbr: number[];
  mbc: number[]; vbc: number[];
  mWo: number[]; vWo: number[];
  mbo: number; vbo: number;
}

function adamInit(H: number): AdamState {
  return {
    mWz: zeros(H), vWz: zeros(H),
    mWr: zeros(H), vWr: zeros(H),
    mWc: zeros(H), vWc: zeros(H),
    mUz: zeros(H * H), vUz: zeros(H * H),
    mUr: zeros(H * H), vUr: zeros(H * H),
    mUc: zeros(H * H), vUc: zeros(H * H),
    mbz: zeros(H), vbz: zeros(H),
    mbr: zeros(H), vbr: zeros(H),
    mbc: zeros(H), vbc: zeros(H),
    mWo: zeros(H), vWo: zeros(H),
    mbo: 0, vbo: 0,
  };
}

const B1 = 0.9;
const B2 = 0.999;
const EPS = 1e-8;

// Single Adam update for a parameter array in place.
function adamStep(
  param: number[],
  grad: number[],
  mAcc: number[],
  vAcc: number[],
  lr: number,
  bc1: number,
  bc2: number,
): void {
  for (let i = 0; i < param.length; i++) {
    mAcc[i] = B1 * mAcc[i] + (1 - B1) * grad[i];
    vAcc[i] = B2 * vAcc[i] + (1 - B2) * grad[i] * grad[i];
    const mHat = mAcc[i] / bc1;
    const vHat = vAcc[i] / bc2;
    param[i] -= (lr * mHat) / (Math.sqrt(vHat) + EPS);
  }
}

/**
 * Train a tiny GRU for one-step-ahead next-value prediction on `series`
 * (oldest→newest). Deterministic in (series, cfg). Returns learned weights +
 * normalization stats. Never throws for usable series; degenerate/too-short
 * series yield an (effectively constant-mean) model.
 */
export function trainGru(series: number[], cfg: GruConfig = {}): TrainedGru {
  const H = cfg.hiddenSize ?? DEFAULTS.hiddenSize;
  const epochs = cfg.epochs ?? DEFAULTS.epochs;
  const lr = cfg.lr ?? DEFAULTS.lr;
  const seed = cfg.seed ?? DEFAULTS.seed;

  // Normalization (z-score). Guard a flat/degenerate series (std→1).
  const clean = series.filter((v) => Number.isFinite(v));
  const n = clean.length;
  const mean = n > 0 ? clean.reduce((a, b) => a + b, 0) / n : 0;
  let variance = 0;
  for (const v of clean) variance += (v - mean) ** 2;
  const std = n > 1 ? Math.sqrt(variance / n) : 0;
  const safeStd = std > 1e-9 ? std : 1;

  const rng = mulberry32(seed);
  const scale = 0.3;
  const model: TrainedGru = {
    hiddenSize: H,
    Wz: randVec(rng, H, scale),
    Wr: randVec(rng, H, scale),
    Wc: randVec(rng, H, scale),
    Uz: randVec(rng, H * H, scale),
    Ur: randVec(rng, H * H, scale),
    Uc: randVec(rng, H * H, scale),
    bz: zeros(H),
    br: zeros(H),
    bc: zeros(H),
    Wo: randVec(rng, H, scale),
    bo: 0,
    mean,
    std: safeStd,
  };

  // Need at least 2 points to form one (input, next) pair.
  if (n < 2) return model;

  // Normalized series oldest→newest. Target at step t is the normalized value
  // at t+1 (one-step-ahead); the last step has no target (null).
  const xs = clean.map((v) => (v - mean) / safeStd);
  const targets: Array<number | null> = xs.map((_, t) =>
    t + 1 < xs.length ? xs[t + 1] : null,
  );

  const adam = adamInit(H);
  let step = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const { caches, preds } = forwardSequence(model, xs);
    const g = zeroGrads(H);
    backward(model, caches, preds, targets, g);
    step++;
    const bc1 = 1 - Math.pow(B1, step);
    const bc2 = 1 - Math.pow(B2, step);
    adamStep(model.Wz, g.Wz, adam.mWz, adam.vWz, lr, bc1, bc2);
    adamStep(model.Wr, g.Wr, adam.mWr, adam.vWr, lr, bc1, bc2);
    adamStep(model.Wc, g.Wc, adam.mWc, adam.vWc, lr, bc1, bc2);
    adamStep(model.Uz, g.Uz, adam.mUz, adam.vUz, lr, bc1, bc2);
    adamStep(model.Ur, g.Ur, adam.mUr, adam.vUr, lr, bc1, bc2);
    adamStep(model.Uc, g.Uc, adam.mUc, adam.vUc, lr, bc1, bc2);
    adamStep(model.bz, g.bz, adam.mbz, adam.vbz, lr, bc1, bc2);
    adamStep(model.br, g.br, adam.mbr, adam.vbr, lr, bc1, bc2);
    adamStep(model.bc, g.bc, adam.mbc, adam.vbc, lr, bc1, bc2);
    adamStep(model.Wo, g.Wo, adam.mWo, adam.vWo, lr, bc1, bc2);
    // Scalar bo via a length-1 wrapper.
    const boArr = [model.bo];
    const mboArr = [adam.mbo];
    const vboArr = [adam.vbo];
    adamStep(boArr, [g.bo], mboArr, vboArr, lr, bc1, bc2);
    model.bo = boArr[0];
    adam.mbo = mboArr[0];
    adam.vbo = vboArr[0];
  }

  return model;
}

/**
 * Predict the value that comes AFTER `series` (oldest→newest) using a trained
 * model. Runs the GRU forward over the whole series and reads out the
 * prediction at the final step, de-normalized. Pure & deterministic.
 */
export function gruPredictNext(model: TrainedGru, series: number[]): number {
  const clean = series.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return model.mean;
  const xs = clean.map((v) => (v - model.mean) / model.std);
  const { preds } = forwardSequence(model, xs);
  const yNorm = preds[preds.length - 1];
  return yNorm * model.std + model.mean;
}

/**
 * Train on `series` (oldest→newest) and roll forward `stepsAhead` values
 * autoregressively, returning the final forecast. `stepsAhead < 1` returns the
 * immediate next-step prediction. Deterministic in (series, stepsAhead, cfg).
 */
export function gruForecast(
  series: number[],
  stepsAhead: number,
  cfg: GruConfig = {},
): number {
  const model = trainGru(series, cfg);
  const clean = series.filter((v) => Number.isFinite(v));
  const steps = Math.max(1, Math.round(stepsAhead));
  const work = clean.slice();
  let next = gruPredictNext(model, work);
  for (let k = 1; k < steps; k++) {
    work.push(next);
    next = gruPredictNext(model, work);
  }
  return next;
}
