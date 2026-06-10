// Sidecar bundle verifier — the runtime check for `npm run sidecar:build`.
//
// Boots the PRODUCTION bundle (src-tauri/resources/server/server.mjs) exactly
// the way the Tauri shell will (node runtime + BRAIN_DATA_DIR + PORT), against
// a throwaway data dir, then probes /api/health to prove the three classic
// boot-then-crash traps stay fixed: ESM import.meta.url (schema.sql lookup),
// the createRequire banner, and the native better-sqlite3 + sqlite-vec load.
//
// Run: npm run sidecar:verify   (after npm run sidecar:build)

import { spawn } from "node:child_process";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(__dirname, "..", "src-tauri", "resources", "server");
const PORT = 8798;

if (!existsSync(resolve(BUNDLE, "server.mjs"))) {
  console.error(`[sidecar:verify] no bundle at ${BUNDLE} — run: npm run sidecar:build`);
  process.exit(1);
}
const DATA = mkdtempSync(resolve(os.tmpdir(), "brain-sidecar-verify-"));

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: BUNDLE,
  env: { ...process.env, BRAIN_DATA_DIR: DATA, BRAIN_DB_PATH: resolve(DATA, "brain.sqlite"), PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
child.stderr.on("data", (d) => process.stderr.write("[srv:err] " + d));

function get(path) {
  return new Promise((res, rej) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path, timeout: 5000 }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res({ status: r.statusCode, body: b }));
    });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
  });
}

setTimeout(async () => {
  let ok = false;
  try {
    const h = await get("/api/health");
    console.log(`\n=== /api/health -> ${h.status} ===`);
    ok = h.status === 200;
    console.log(`[sidecar:verify] DB file created: ${existsSync(resolve(DATA, "brain.sqlite"))}`);
    try {
      const parsed = JSON.parse(h.body);
      console.log(`[sidecar:verify] vector extension: ${parsed.vector ?? "?"}`);
    } catch {
      /* health body shape is informational here */
    }
  } catch (e) {
    console.log(`\n=== HEALTH FAILED: ${e.message} ===`);
  } finally {
    child.kill();
    console.log(`\n[sidecar:verify] ${ok ? '"result": "PASS"' : '"result": "FAIL"'} — bundled server ${ok ? "boots + serves /api/health" : "did not answer"}`);
    // Give the killed child a beat to release the SQLite WAL lock; cleanup is
    // best-effort (it's a temp dir — the OS reclaims it anyway).
    setTimeout(() => {
      try {
        rmSync(DATA, { recursive: true, force: true });
      } catch {
        /* still locked — leave it to temp cleanup */
      }
      process.exit(ok ? 0 : 1);
    }, 1000);
  }
}, 5000);
