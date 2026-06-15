// One-off CLI: add a SPECIFIC GitHub repo to the brain WITHOUT booting the server
// — a thin wrapper over the same first-class path the new POST /api/github/learn-repo
// route and the `github-learn-repo` action use (server/src/github/index.ts ::
// learnRepoRef). Handy for a quick offline "add this repo" with a before/after
// report; the running brain exposes the identical capability over HTTP + the pet.
//
// Egress obeys CONFIG.localOnly exactly as the route does (the gate + host pin
// live inside github/discovery.ts). Embeddings use the same resolveEmbedFn
// fallback (default connector → local Ollama) so the README joins the vector
// index even when the default chat model is remote.
//
// Usage:  tsx server/scripts/_learn-repo.ts [owner/name | github URL]
//         (defaults to deepbeepmeep/Wan2GP)

import { CONFIG } from "../src/config.js"; // importing this loads root .env via dotenv
import { openDb } from "../src/db/sqlite.js";
import {
  ensureDefaultConnector,
  reconcileDiscovered,
  resolveEmbedFn,
} from "../src/connectors/registry.js";
import { learnRepoRef } from "../src/github/index.js";
import { countMemoryPoints, keywordSearch } from "../src/db/repositories/memory.js";

async function main(): Promise<void> {
  const ref = process.argv[2] ?? "deepbeepmeep/Wan2GP";

  openDb();
  ensureDefaultConnector();
  // Refresh local-runtime detection so resolveEmbedFn can fall back to a live
  // local Ollama embedder when the default chat connector is remote/embedless.
  try {
    await reconcileDiscovered();
  } catch {
    /* discovery is best-effort; we degrade to keyword-only storage if it fails */
  }

  console.log(
    `LOCAL_ONLY = ${CONFIG.localOnly}  → GitHub egress ${
      CONFIG.localOnly ? "BLOCKED (set LOCAL_ONLY=false to allow)" : "allowed"
    }`,
  );
  const embed = resolveEmbedFn();
  console.log(`embedder   = ${embed ? "resolved (README joins the vector index)" : "none → keyword-retrievable only"}`);

  const before = countMemoryPoints();
  const r = await learnRepoRef(ref, { embed });
  const after = countMemoryPoints();

  console.log(`\n${r.ok ? "OK " : "FAILED"} ${r.repo}${r.stars ? ` (★${r.stars})` : ""}`);
  if (r.url) console.log(`  url            : ${r.url}`);
  if (r.reason) console.log(`  reason         : ${r.reason}`);
  console.log(`  ingested (new) : ${r.ingested}`);
  console.log(`  deduped (known): ${r.deduped}`);
  console.log(`  memory total   : ${before} → ${after}`);

  // Retrievability check: prove it's findable in the brain by repo name.
  const probe = keywordSearch(r.repo.split("/")[1] ?? r.repo, 5);
  const mine = probe.filter((h) => String(h.memory.metadata?.source ?? "") === "ingest:github");
  console.log(`\nKeyword probe: ${probe.length} content hits (${mine.length} from ingest:github)`);

  process.exit(r.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("learn-repo failed:", err);
  process.exit(1);
});
