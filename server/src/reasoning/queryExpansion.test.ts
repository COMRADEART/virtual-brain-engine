import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryPoint } from "../../../shared/memory.js";
import type { VectorSearchHit } from "../db/repositories/memory.js";
import { reciprocalRankFusion } from "./queryExpansion.js";

function hit(id: string, score: number): VectorSearchHit {
  return { memory: { id, content: id } as MemoryPoint, score } as VectorSearchHit;
}

test("an item ranked in multiple lists outranks one seen only once", () => {
  // `a` appears in both lists, `b` and `c` each in one — RRF should float `a` to the top.
  const fused = reciprocalRankFusion([
    [hit("b", 0.9), hit("a", 0.4)],
    [hit("c", 0.8), hit("a", 0.5)],
  ]);
  assert.equal(fused[0].memory.id, "a");
});

test("fused score is the MAX cosine across lists (keeps vecScore a real cosine)", () => {
  const fused = reciprocalRankFusion([[hit("a", 0.4)], [hit("a", 0.91)]]);
  assert.equal(fused.length, 1, "deduped by id");
  assert.equal(fused[0].score, 0.91);
});

test("respects the limit", () => {
  const list = [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7), hit("d", 0.6)];
  assert.equal(reciprocalRankFusion([list], { limit: 2 }).length, 2);
});

test("a single list passes through in order with its own scores", () => {
  const fused = reciprocalRankFusion([[hit("a", 0.9), hit("b", 0.5)]]);
  assert.deepEqual(
    fused.map((f) => f.memory.id),
    ["a", "b"],
  );
  assert.equal(fused[0].score, 0.9);
});

test("empty input yields an empty result", () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(reciprocalRankFusion([[]]), []);
});
