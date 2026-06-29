import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMarkerIds, validateMarkers } from "./citations.js";

test("extractMarkerIds returns ids in order of appearance, including repeats", () => {
  assert.deepEqual(extractMarkerIds("see [m:abc] and [m:def] and [m:abc]"), ["abc", "def", "abc"]);
  assert.deepEqual(extractMarkerIds("no markers here"), []);
});

test("extractMarkerIds is repeatable (no shared-regex lastIndex footgun)", () => {
  const text = "[m:a1] [m:b2]";
  assert.deepEqual(extractMarkerIds(text), extractMarkerIds(text));
});

test("validateMarkers leaves an answer with only known ids untouched", () => {
  const known = new Set(["abc", "def"]);
  const answer = "Known memory:\n[m:abc]\nInferred reasoning:\n[m:def]\nUncertain:\nnone";
  assert.equal(validateMarkers(answer, known), answer);
});

test("validateMarkers strips hallucinated (unknown) markers", () => {
  const known = new Set(["real"]);
  const out = validateMarkers("trust [m:real] but not [m:fake]", known);
  assert.ok(out.includes("[m:real]"), "known marker survives");
  assert.ok(!out.includes("[m:fake]"), "unknown marker removed");
});

test("validateMarkers notes the strip inside an existing Uncertain section", () => {
  const known = new Set<string>();
  const out = validateMarkers("Inferred reasoning:\n[m:ghost]\nUncertain:\nlow", known);
  assert.ok(!out.includes("[m:ghost]"));
  assert.match(out, /Uncertain:\s*Stripped 1 unknown memory marker\(s\)/);
});

test("validateMarkers removes every occurrence of a repeated unknown id", () => {
  const out = validateMarkers("[m:x] middle [m:x] end", new Set<string>());
  assert.ok(!out.includes("[m:x]"), "all copies of the unknown id removed");
});
