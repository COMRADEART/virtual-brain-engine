// Build the Node server as a Tauri-bundled sidecar.
//
// Output layout (consumed by src-tauri/tauri.conf.json):
//   src-tauri/binaries/brain-server-<target-triple>[.exe]   <- externalBin: a
//       copy of the Node runtime (preserves the exec bit cross-platform).
//   src-tauri/resources/server/server.mjs                   <- bundled server
//   src-tauri/resources/server/schema.sql                   <- runtime asset
//   src-tauri/resources/server/node_modules/**              <- native deps only
//
// At runtime Rust (src-tauri/src/sidecars.rs) launches the sidecar with the
// resource path to server.mjs as its arg, BRAIN_DATA_DIR pointed at the app
// data dir, and PORT=8787.
//
// The bundling recipe is the validated spike result — see the memory
// `sidecar-packaging-bundler`. Three non-obvious requirements, do not "simplify":
//   1. format MUST be esm (CJS empties import.meta.url -> __dirname/schema.sql break).
//   2. the createRequire banner is required (bundled CJS deps call require()).
//   3. copy native node_modules by directory, not require.resolve(pkg/package.json)
//      (sqlite-vec's exports map blocks the subpath and silently drops it).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const SERVER = resolve(REPO, "server");
const NM = resolve(SERVER, "node_modules");
const TAURI = resolve(REPO, "src-tauri");
const BIN_DIR = resolve(TAURI, "binaries");
const RES_DIR = resolve(TAURI, "resources", "server");

// Packages that MUST stay external (native or runtime path-resolved) and ship
// as real node_modules adjacent to the bundle.
const NATIVE_EXTERNALS = ["better-sqlite3", "sqlite-vec"];
// Install-only deps not required at runtime (drops ~30 transitive pkgs).
const SKIP = new Set(["prebuild-install"]);

function rustTargetTriple() {
  // Match Tauri's externalBin naming: brain-server-<triple><ext>.
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/host:\s*(\S+)/);
  if (!m) throw new Error("could not parse `rustc -vV` host triple");
  return m[1];
}

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

const copied = new Set();
function copyPkg(name) {
  if (copied.has(name) || SKIP.has(name)) return;
  const src = resolve(NM, name);
  const pkgJsonPath = resolve(src, "package.json");
  if (!existsSync(pkgJsonPath)) return; // not installed for this platform
  copied.add(name);
  const dest = resolve(RES_DIR, "node_modules", name);
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
  const triple = rustTargetTriple();
  const exe = process.platform === "win32" ? ".exe" : "";
  const sidecarName = `brain-server-${triple}${exe}`;

  rmSync(RES_DIR, { recursive: true, force: true });
  mkdirSync(RES_DIR, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });

  await build({
    entryPoints: [resolve(SERVER, "src/index.ts")],
    outfile: resolve(RES_DIR, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: NATIVE_EXTERNALS,
    plugins: [tsResolve],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: "info",
  });

  copyFileSync(resolve(SERVER, "src/db/schema.sql"), resolve(RES_DIR, "schema.sql"));

  for (const ext of NATIVE_EXTERNALS) copyPkg(ext);
  // sqlite-vec resolves its platform pkg (e.g. sqlite-vec-windows-x64) by name
  // at runtime; copyPkg above already pulled it via optionalDependencies, but
  // be explicit so a future deps change can't silently drop the loadable .dll.
  for (const variant of [
    "sqlite-vec-windows-x64",
    "sqlite-vec-linux-x64",
    "sqlite-vec-linux-arm64",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-darwin-arm64",
  ]) {
    copyPkg(variant);
  }

  // The Node runtime, renamed to the sidecar binary Tauri expects. Using the
  // build machine's own node keeps the version in lockstep with what the
  // bundle was built against.
  copyFileSync(process.execPath, resolve(BIN_DIR, sidecarName));

  console.log(`\n[build-server-sidecar] target triple : ${triple}`);
  console.log(`[build-server-sidecar] sidecar binary: src-tauri/binaries/${sidecarName}`);
  console.log(`[build-server-sidecar] payload       : src-tauri/resources/server/`);
  console.log(`[build-server-sidecar] node_modules  : ${[...copied].join(", ")}`);
}

main().catch((e) => {
  console.error("[build-server-sidecar] FAILED:", e);
  process.exit(1);
});
