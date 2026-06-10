// Phase 2 runtime verification floor — `npm run perception:probe` (opt-in; needs
// Ollama). The hermetic perception:selfcheck proves the dedup gate + storage with
// SYNTHETIC vectors; it cannot prove the REAL "make-it-real" bar: a perception
// caption, embedded by the real model, actually (a) SURFACES in retrieval when
// relevant and (b) does NOT bury genuine file/conversation memory (the importance
// discount + dedup must hold against real geometry). OmniParser itself can't run
// here (no torch) — that screen→parse half is the user's GPU/desktop check — but
// the caption→embedded→retrievable half IS verifiable, and that's the bar.
// Uses a throwaway temp DB (BRAIN_DB_PATH); never the real brain.sqlite.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

const tmp = join(process.env.TEMP || "/tmp", `perception-probe-${randomUUID()}.sqlite`);
process.env.BRAIN_DB_PATH = tmp;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
const { openDb, isVectorAvailable } = await imp("src/db/sqlite.ts");
const { upsertMemoryPoint, vectorSearch } = await imp("src/db/repositories/memory.ts");
const { ingestPerceptionMemory, countPerceptionMemories } = await imp("src/vision/perceptionMemory.ts");

const BASE = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
async function embed(text) {
  const r = await fetch(`${BASE}/api/embeddings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d.embedding)) throw new Error("no embedding");
  return d.embedding;
}

openDb();
let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};
check("sqlite-vec available (probe is meaningful)", isVectorAvailable());

// (1) A perception caption becomes retrievable: ingest a frame about editing the
// router, then query for it and confirm it comes back among the hits.
const capContent = "Visual Studio Code: editing server/src/reasoning/router.ts — the MoE query router";
await ingestPerceptionMemory({ content: capContent, embedding: await embed(capContent), windowTitle: "VS Code" });
check("perception caption stored as retrievable memory", countPerceptionMemories() === 1);

const q1 = await embed("what file was I editing in my code editor?");
const hits1 = vectorSearch(q1, 8);
const surfaced = hits1.some((h) => h.memory.content === capContent);
check("perception caption SURFACES in retrieval for a relevant query", surfaced,
  `topHits=${hits1.slice(0, 3).map((h) => (h.memory.metadata?.kind === "perception" ? "PERCEPTION" : "other")).join(",")}`);

// (2) Anti-flooding: 40 near-identical idle frames must NOT bury a genuinely
// relevant file memory. Dedup should collapse the 40 to ~1, and the importance
// discount should keep even that one from outranking the real on-topic memory.
for (let i = 0; i < 40; i++) {
  const c = `Google Chrome: reading a news article about the weather (scroll ${i})`;
  // near-identical embeddings: embed the same base text so cosine > DEDUP_COS
  await ingestPerceptionMemory({ content: c, embedding: await embed("Google Chrome: reading a news article about the weather"), windowTitle: "Chrome" });
}
check("40 near-identical idle frames collapsed by dedup (<= 3 stored)", countPerceptionMemories() <= 3,
  `perceptionCount=${countPerceptionMemories()}`);

// A real, on-topic file memory the user genuinely cares about.
const fileContent = "The SQLite vector extension sqlite-vec is loaded in db/sqlite.ts and powers memory_vec similarity search.";
upsertMemoryPoint({
  sourceType: "chunk", filePath: "server/src/db/sqlite.ts", projectName: "star", title: "sqlite-vec loader",
  content: fileContent, contentHash: "probe-file-" + randomUUID(), embedding: await embed(fileContent), importance: 0.6,
});

const q2 = await embed("how does the vector similarity search extension get loaded?");
const hits2 = vectorSearch(q2, 8);
const topIsFile = hits2.length > 0 && hits2[0].memory.content === fileContent;
const fileRank = hits2.findIndex((h) => h.memory.content === fileContent);
check("genuine file memory is NOT buried by the perception stream (ranks #1 on its topic)", topIsFile,
  `fileRank=${fileRank} of ${hits2.length}`);

try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch {}
try { for (const ext of ["-wal", "-shm"]) if (existsSync(tmp + ext)) rmSync(tmp + ext, { force: true }); } catch {}

console.log(JSON.stringify({ failures, result: failures === 0 ? "PASS" : "FAIL" }));
process.exit(failures === 0 ? 0 : 1);
