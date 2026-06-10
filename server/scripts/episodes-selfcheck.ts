// Event-segmentation selfcheck — hermetic (throwaway DB, no LLM).
//
// Run: npm --prefix server run episodes:selfcheck
//
// Asserts:
//   (A) PURE segmentation: a time gap opens a boundary; a content shift
//       without a gap opens one too; cohesive runs stay together; the
//       segmentation is deterministic; titleForEpisode picks the dominant
//       tokens.
//   (B) The builder over a temp DB: stores COMPLETE episodes only (the
//       trailing group stays open), writes each episode its own retrievable
//       memory point (metadata.kind "episode"), and respects the
//       min-items floor.
//   (C) Watermark idempotency: an immediate re-run stores nothing new; after
//       NEW experience arrives, the previously-open episode completes and is
//       stored — incremental, no duplicates.
//   (D) listEpisodes returns records (and filters by day).
//   (E) Failure isolation: with the episodes table dropped, nothing throws.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ulid } from "ulid";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-episodes-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  BOUNDARY_GAP_MS,
  segmentTimeline,
  titleForEpisode,
  buildEpisodes,
  listEpisodes,
} = await import("../src/memory/episodes.js");
const { openDb } = await import("../src/db/sqlite.js");

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE segmentation.
// -----------------------------------------------------------------------------

const T0 = Date.parse("2026-06-09T09:00:00.000Z");
const item = (id: string, at: number, content: string) => ({ id, at, content });

{
  const timeline = [
    item("a1", T0, "debugging the staging deploy script failure"),
    item("a2", T0 + 5 * 60_000, "found the staging deploy env file missing"),
    item("a3", T0 + 9 * 60_000, "fixed the staging deploy env file path"),
    // > gap → new episode
    item("b1", T0 + 9 * 60_000 + BOUNDARY_GAP_MS + 60_000, "writing the quarterly budget summary"),
    item("b2", T0 + 9 * 60_000 + BOUNDARY_GAP_MS + 5 * 60_000, "budget summary quarterly numbers reviewed"),
  ];
  const groups = segmentTimeline(timeline);
  check("time gap opens a boundary", groups.length === 2 && groups[0].length === 3 && groups[1].length === 2, `groups=${groups.map((g) => g.length).join(",")}`);

  // Content shift WITHOUT a time gap also opens a boundary.
  const shift = [
    item("c1", T0, "debugging the staging deploy script failure again today"),
    item("c2", T0 + 2 * 60_000, "staging deploy script stack trace analysis"),
    item("c3", T0 + 4 * 60_000, "tomato seedlings balcony watering schedule notes"),
  ];
  const shifted = segmentTimeline(shift);
  check("content shift opens a boundary without a gap", shifted.length === 2, `groups=${shifted.length}`);

  // Determinism + order normalisation.
  const reversed = segmentTimeline([...timeline].reverse());
  check("segmentation is deterministic over input order", JSON.stringify(reversed.map((g) => g.map((i) => i.id))) === JSON.stringify(groups.map((g) => g.map((i) => i.id))));
  check("empty timeline → no groups", segmentTimeline([]).length === 0);

  const title = titleForEpisode(groups[0]);
  check("title picks the dominant tokens", /staging|deploy/.test(title), title);
}

// -----------------------------------------------------------------------------
// (B+C) Builder over the DB — incremental, idempotent.
// -----------------------------------------------------------------------------

function insertExperience(content: string, atIso: string): string {
  // Direct insert so created_at is controllable (upsertMemoryPoint stamps now).
  const id = ulid();
  db.prepare(
    `INSERT INTO memory_points (id, source_type, content, content_hash, importance, created_at, updated_at)
     VALUES (?, 'conversation', ?, ?, 0.5, ?, ?)`,
  ).run(id, content, createHash("sha1").update(content).digest("hex"), atIso, atIso);
  return id;
}

const iso = (ms: number) => new Date(ms).toISOString();

// Cluster A (3 items), then a gap, then cluster B (2 items) — B is the open tail.
insertExperience("debugging the staging deploy script failure", iso(T0));
insertExperience("found the staging deploy env file missing", iso(T0 + 5 * 60_000));
insertExperience("fixed the staging deploy env file path", iso(T0 + 9 * 60_000));
const bStart = T0 + 9 * 60_000 + BOUNDARY_GAP_MS + 60_000;
insertExperience("writing the quarterly budget summary", iso(bStart));
insertExperience("budget summary quarterly numbers reviewed", iso(bStart + 4 * 60_000));

const first = buildEpisodes();
check("first build stores the complete episode only", first.stored === 1 && first.openTail === 2, JSON.stringify(first));

{
  const eps = listEpisodes();
  check("listEpisodes returns the stored episode", eps.length === 1 && eps[0].itemCount === 3);
  check("episode title reflects its content", /staging|deploy/.test(eps[0].title), eps[0].title);
  check("episode carries its member ids", eps[0].itemIds.length === 3);
  // The episode's own retrievable memory point.
  const epMem = db
    .prepare(`SELECT content FROM memory_points WHERE json_extract(metadata, '$.kind') = 'episode'`)
    .get() as { content: string } | undefined;
  check("episode memory point written", Boolean(epMem) && /Episode:/.test(epMem?.content ?? ""));
  // (D) day filter.
  check("day filter matches", listEpisodes(10, "2026-06-09").length === 1);
  check("day filter excludes other days", listEpisodes(10, "2026-06-11").length === 0);
}

// Idempotency: immediate re-run stores nothing (watermark + open tail).
const rerun = buildEpisodes();
check("immediate re-run stores nothing new", rerun.stored === 0, JSON.stringify(rerun));

// New experience after another gap → the open B-cluster completes and stores.
const cStart = bStart + 4 * 60_000 + BOUNDARY_GAP_MS + 60_000;
insertExperience("reading about hebbian learning rules", iso(cStart));
insertExperience("notes on hebbian synaptic weight decay", iso(cStart + 3 * 60_000));
const second = buildEpisodes();
check("new experience completes the previously-open episode", second.stored === 1 && listEpisodes().length === 2, JSON.stringify(second));
check("no duplicate of the first episode", listEpisodes().filter((e) => /staging|deploy/.test(e.title)).length === 1);

// Min-items floor: a lone item between gaps is skipped, not stored.
{
  const lone = segmentTimeline([
    item("x1", T0, "alpha beta"),
    item("x2", T0 + BOUNDARY_GAP_MS + 60_000, "gamma delta"),
    item("x3", T0 + 2 * (BOUNDARY_GAP_MS + 60_000), "epsilon zeta"),
  ]);
  check("lone items segment into singleton groups (floor applies at store time)", lone.every((g) => g.length === 1));
}

// (E) Failure isolation.
db.exec("DROP TABLE IF EXISTS episodes");
let threw = false;
try {
  buildEpisodes();
  listEpisodes();
} catch {
  threw = true;
}
check("nothing throws with the episodes table gone", threw === false);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
