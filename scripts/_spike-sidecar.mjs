// THROWAWAY spike (advisor-mandated): prove a bundled Node server can open
// better-sqlite3 + load sqlite-vec from a directory where the repo is NOT
// checked out. The result picks the production bundler. Delete after.
//
// Strategy under test (Candidate C, robust): esbuild-bundle server/src to a
// single server.cjs, keep the native packages external, ship their real
// node_modules trees + schema.sql adjacent. Run with a portable node.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const SERVER = resolve(REPO, "server");
const NM = resolve(SERVER, "node_modules");
const OUT = resolve(os.tmpdir(), "brain-sidecar-spike");

// Install-only deps that are NOT required at runtime (better-sqlite3 only
// touches prebuild-install in its npm install script, never in lib/). Skipping
// it drops ~30 transitive packages (tar-fs, bl, ...) from the shipped tree.
const SKIP = new Set(["prebuild-install"]);

// The native packages that MUST stay external + ship as real node_modules.
const NATIVE_EXTERNALS = ["better-sqlite3", "sqlite-vec"];

// Map explicit `.js` relative imports back onto their `.ts` sources (the
// server is ESM-on-disk-as-.ts; Node needs the .js suffix, esbuild needs help).
const tsResolve = {
  name: "ts-js-resolve",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point" || !args.path.startsWith(".")) return;
      const abs = resolve(args.resolveDir, args.path);
      for (const ts of [abs.replace(/\.js$/, ".ts"), abs.replace(/\.js$/, ".tsx")]) {
        if (existsSync(ts)) return { path: ts };
      }
      return;
    });
  },
};

// Recursively copy a node_modules package + its (optional) deps from
// server/node_modules into OUT/node_modules. Missing optional platform
// packages (linux/darwin variants) resolve-fail and are skipped — fine.
const copied = new Set();
function copyPkg(name) {
  if (copied.has(name) || SKIP.has(name)) return;
  // Resolve by directory, NOT require.resolve("<name>/package.json") — packages
  // with an "exports" map (e.g. sqlite-vec) block subpath access to
  // package.json and would throw, silently dropping a required native dep.
  const src = resolve(NM, name);
  const pkgJsonPath = resolve(src, "package.json");
  if (!existsSync(pkgJsonPath)) return; // not installed (e.g. other-OS vec variant)
  copied.add(name);
  const dest = resolve(OUT, "node_modules", name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  const meta = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  for (const dep of [
    ...Object.keys(meta.dependencies ?? {}),
    ...Object.keys(meta.optionalDependencies ?? {}),
  ]) {
    copyPkg(dep);
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  await build({
    entryPoints: [resolve(SERVER, "src/index.ts")],
    outfile: resolve(OUT, "server.mjs"),
    bundle: true,
    platform: "node",
    // ESM keeps import.meta.url native -> __dirname (schema.sql) + REPO_ROOT
    // resolve correctly. External CJS natives import fine via Node interop.
    format: "esm",
    target: "node20",
    external: NATIVE_EXTERNALS,
    plugins: [tsResolve],
    // Bundled CJS deps (express/body-parser/depd) call require() internally;
    // in ESM output esbuild's __require throws on those unless a real require
    // exists in scope. Inject one bound to this module's URL.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: "info",
  });

  // schema.sql is read at runtime via resolve(__dirname, "schema.sql").
  copyFileSync(resolve(SERVER, "src/db/schema.sql"), resolve(OUT, "schema.sql"));

  for (const ext of NATIVE_EXTERNALS) copyPkg(ext);
  // sqlite-vec resolves its platform pkg by name; ensure the windows variant.
  copyPkg("sqlite-vec-windows-x64");

  console.log(`\n[spike] built → ${OUT}`);
  console.log(`[spike] node_modules shipped: ${[...copied].join(", ")}`);
}

main().catch((e) => {
  console.error("[spike] FAILED:", e);
  process.exit(1);
});
