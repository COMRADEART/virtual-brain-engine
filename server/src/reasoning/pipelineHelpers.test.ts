import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryPoint } from "../../../shared/memory.js";
import { safeJson, snippetFor, ensureSections } from "./pipelineHelpers.js";

test("safeJson parses clean JSON", () => {
  assert.deepEqual(safeJson<{ a: number }>('{"a":1}'), { a: 1 });
});

test("safeJson recovers the first object from chatty model output", () => {
  assert.deepEqual(safeJson<{ ok: boolean }>('Sure! {"ok":true} hope that helps'), { ok: true });
});

test("safeJson returns null on unrecoverable garbage", () => {
  assert.equal(safeJson("not json at all"), null);
  assert.equal(safeJson("{ broken: "), null);
});

test("snippetFor truncates content over 600 chars with an ellipsis", () => {
  const short = { content: "  hello  " } as MemoryPoint;
  assert.equal(snippetFor(short), "hello");

  const long = { content: "x".repeat(700) } as MemoryPoint;
  const out = snippetFor(long);
  assert.equal(out.length, 601); // 600 chars + the ellipsis
  assert.ok(out.endsWith("…"));
});

test("ensureSections validates markers when the three sections are present", () => {
  const answer = "Known memory:\n[m:keep] [m:drop]\nInferred reasoning:\nx\nUncertain:\ny";
  const out = ensureSections(answer, new Set(["keep"]));
  assert.ok(out.includes("[m:keep]"));
  assert.ok(!out.includes("[m:drop]"), "unknown marker stripped");
});

test("ensureSections rewraps a malformed answer into the three-section template", () => {
  const out = ensureSections("just some freeform text", new Set());
  assert.ok(out.includes("Known memory:"));
  assert.ok(out.includes("Inferred reasoning:"));
  assert.ok(out.includes("Uncertain:"));
  assert.ok(out.includes("just some freeform text"));
});

test("ensureSections strips a forged marker on the malformed (rewrap) path too", () => {
  // No section headers → rewrap branch. A forged [m:ghost] citation (not in the
  // known set) must still be stripped — the citation contract holds on EVERY path.
  const out = ensureSections("freeform with a forged [m:ghost] citation", new Set(["real"]));
  assert.ok(!out.includes("[m:ghost]"), "forged marker stripped on the rewrap path");
  assert.ok(out.includes("Stripped 1 unknown memory marker"), "strip noted in the Uncertain section");
});

test("ensureSections preserves a known marker on the malformed (rewrap) path", () => {
  const out = ensureSections("freeform mentioning [m:real]", new Set(["real"]));
  assert.ok(out.includes("[m:real]"), "a known marker survives the rewrap path");
  assert.ok(!out.includes("Stripped"), "nothing stripped when every marker is known");
});
