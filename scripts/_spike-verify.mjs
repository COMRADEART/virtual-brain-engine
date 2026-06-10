// THROWAWAY spike verifier. Boots the bundled server.mjs from the temp build
// dir (outside the repo) and probes /api/health to confirm better-sqlite3 +
// sqlite-vec load at runtime. Run it with:  node scripts/_spike-verify.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";

const OUT = resolve(os.tmpdir(), "brain-sidecar-spike");
const DATA = resolve(os.tmpdir(), "brain-spike-data");
const PORT = 8799;

if (!existsSync(resolve(OUT, "server.mjs"))) {
  console.error(`[verify] no bundle at ${OUT} — run: node scripts/_spike-sidecar.mjs`);
  process.exit(1);
}
rmSync(DATA, { recursive: true, force: true });

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: OUT,
  env: { ...process.env, BRAIN_DATA_DIR: DATA, PORT: String(PORT), HOST: "127.0.0.1" },
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
    console.log(h.body);
    ok = h.status === 200;
    console.log(`\n[verify] DB file created: ${existsSync(resolve(DATA, "brain.sqlite"))}`);
    try {
      const parsed = JSON.parse(h.body);
      console.log(`[verify] vector extension: ${parsed.vector ?? "?"}`);
    } catch {}
  } catch (e) {
    console.log(`\n=== HEALTH FAILED: ${e.message} ===`);
  } finally {
    child.kill();
    console.log(`\n[verify] RESULT: ${ok ? "PASS ✅ (bundled server boots + serves /api/health)" : "FAIL ❌"}`);
    process.exit(ok ? 0 : 1);
  }
}, 4500);
