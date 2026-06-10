// Phase 1d runtime verification floor — `npm run cluster:probe` (opt-in; needs
// Ollama). The hermetic memory:selfcheck proves the cosine DECISION LOGIC with
// synthetic vectors but CANNOT prove the calibrated EMBEDDING_SIMILARITY_THRESHOLD
// (0.58) matches the real embedder's geometry. This probe embeds real,
// lexically-DISJOINT-but-semantically-related texts with the configured Ollama
// model, stores them through the real upsertMemoryPoint → memory_vec path, runs
// the real updateClusterForMemory, and asserts the related trio MERGES into one
// cluster (which string-Jaccard never would) while two unrelated texts stay
// separate. Re-run this after changing OLLAMA_EMBED_MODEL to re-validate the
// threshold. Uses a throwaway temp DB (BRAIN_DB_PATH set below); never the real one.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

const tmp = join(process.env.TEMP || "/tmp", `probe-cluster-${randomUUID()}.sqlite`);
process.env.BRAIN_DB_PATH = tmp;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
const { openDb, isVectorAvailable } = await imp("src/db/sqlite.ts");
const { upsertMemoryPoint } = await imp("src/db/repositories/memory.ts");
const { updateClusterForMemory, getAllClusters } = await imp("src/memory/semanticCluster.ts");

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

openDb(); // applies schema + migrations + loads sqlite-vec on the temp DB
let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};
check("sqlite-vec available (probe is meaningful)", isVectorAvailable());

// Same event, paraphrased three ways with deliberately LOW word overlap, so a
// merge can only come from embeddings (string Jaccard would keep them apart).
const RELATED = [
  "The server crashed on startup because the SQLite vector extension could not be loaded.",
  "Boot aborted when the native module failed to initialize while opening the datastore.",
  "On launch the process died — the embedded similarity add-on was missing at runtime.",
];
const UNRELATED = [
  "I enjoy brewing dark roast coffee slowly every morning before work.",
  "The hiking trail offers a stunning view of the coastal cliffs at sunset.",
];

async function store(content) {
  const emb = await embed(content);
  const m = upsertMemoryPoint({
    sourceType: "manual", filePath: null, projectName: "(probe)", title: null,
    content, contentHash: createHash("sha1").update(content + randomUUID()).digest("hex"),
    embedding: emb,
  });
  updateClusterForMemory(m.id, content);
  return m.id;
}

const relatedIds = [];
for (const t of RELATED) relatedIds.push(await store(t));
const unrelatedIds = [];
for (const t of UNRELATED) unrelatedIds.push(await store(t));

const clusters = getAllClusters(50);
const bigClusters = clusters.filter((c) => c.memoryIds.length >= 3);
check("exactly one cluster has >= 3 members", bigClusters.length === 1,
  `cluster sizes = [${clusters.map((c) => c.memoryIds.length).sort((a, b) => b - a).join(",")}]`);
const merged = bigClusters[0];
check("the >=3 cluster contains ALL three related (lexically-disjoint) memories",
  !!merged && relatedIds.every((id) => merged.memoryIds.includes(id)),
  merged ? `members=${merged.memoryIds.length}` : "no big cluster");
check("neither unrelated memory joined the related cluster",
  !!merged && unrelatedIds.every((id) => !merged.memoryIds.includes(id)));
check("total cluster count is 3 (related trio + 2 singletons)", clusters.length === 3,
  `got ${clusters.length}`);

try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch {}
try { for (const ext of ["-wal", "-shm"]) if (existsSync(tmp + ext)) rmSync(tmp + ext, { force: true }); } catch {}

console.log(JSON.stringify({ failures, result: failures === 0 ? "PASS" : "FAIL" }));
process.exit(failures === 0 ? 0 : 1);
