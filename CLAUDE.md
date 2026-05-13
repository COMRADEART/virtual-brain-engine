# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

This is a multi-process project, not just a Vite app. Four cooperating pieces live in this repo:

- `src/` — Vite + React + Three.js frontend (the brain visualizer + Brain OS UI).
- `server/` — Express + TypeScript backend on `127.0.0.1:8787`. SQLite (via `better-sqlite3` + `sqlite-vec`), Ollama connector, 7-step reasoning pipeline, WS broadcast.
- `shared/` — pure-TypeScript type definitions imported by both frontend and server (no runtime deps). `pipeline.ts`, `memory.ts`, `connector.ts`.
- `src-tauri/` — Tauri 2 desktop shell (Rust). Wraps the Vite build and adds local file/system-monitor commands. Optional; the web app runs without it.
- `worker/` — Python sidecar **placeholder** for Phase 3 (sentence-transformers, cross-encoder reranking). The MVP does not depend on it being up.

The frontend and server communicate over HTTP (`/api/...`) and a single WebSocket at `/ws/brain`. Pipeline events also stream over SSE on `POST /api/ask`. Both the SSE stream and the WS broadcast carry the same `PipelineEvent` shape (defined in `shared/pipeline.ts`) so that any open tab sees activity even if it didn't initiate the request.

## Commands

### Frontend (root `package.json`)

- `npm run dev` — Vite dev server, bound to `127.0.0.1:5173`. The host binding is intentional (`scripts/verify-canvas.mjs` and the Tauri config both target that exact URL); don't switch it to `0.0.0.0` or a different port without updating those.
- `npm run build` — runs `tsc` (type-check only, `noEmit`) then `vite build`. A type error fails the build.
- `npm run preview` — preview the production build at `127.0.0.1`.

### Server

- `npm run dev:server` — `tsx watch` on `server/src/index.ts`. Listens on `127.0.0.1:8787` by default. Reads `.env` from the repo root. Creates `data/brain.sqlite` on first run.
- `npm run dev:all` — runs Vite **and** the server concurrently. Use this when you're working on anything that crosses the boundary (AskPanel, BrainOS, pipeline overlay, memory dashboard).
- Inside `server/`: `npm run typecheck` (just `tsc --noEmit`). There is no separate test runner in `server/`.

### Desktop (Tauri)

- `npm run tauri:dev` — runs Vite (via `beforeDevCommand` in `tauri.conf.json`) and the Rust shell. Requires the Rust toolchain.
- `npm run tauri:build` — production bundle (msi/nsis on Windows).
- `npm run dev:desktop` — Vite + Tauri concurrently.

### Tests / smoke checks

There is no traditional unit-test runner, linter, or formatter. The static and runtime checks below are the only quality gates wired up:

- `npm run verify:canvas` — headless smoke test (see below). **Requires the dev server to already be running**; it does not start one.
- `npm run test:actions` — per-action assertion suite (`scripts/smoke-actions.mjs`). Clicks each of the 7 action buttons, asserts the active-region route matches `regionDefinitions.ts`, screenshots each state into `artifacts/actions/`, and exercises a region click + the density slider. Same dev-server prerequisite.
- `npm test` — runs `verify:canvas` then `test:actions`.
- `npm run test:all` — orchestrated runner (`scripts/test-all.mjs`) that **does** boot Vite for you, waits until it answers on `127.0.0.1:5173`, runs the two smoke checks, then tears Vite down cleanly (uses `taskkill /T /F` on Windows). If a dev server is already running on 5173 it reuses it. Prefer this over the dev-server-prereq pair when you only need a one-shot pass.
- `npm run scan` — CLI helper (`scripts/scan.mjs`) that triggers `POST /api/scan/run` and streams scan progress over WS. Requires the **server** running.

### verify:canvas

`scripts/verify-canvas.mjs` is the project's end-to-end check. It launches headless Chrome/Edge via the Chrome DevTools Protocol (no Puppeteer dependency), navigates to `VERIFY_URL` (default `http://127.0.0.1:5173/`), samples a 96×60 region of the `<canvas>`, and asserts that ≥90 pixels have luma >24 — i.e. the Three.js scene is actually drawing, not just mounting. It also captures `Runtime.exceptionThrown` and console errors, writes a screenshot to `artifacts/virtual-brain-engine.png`, and exits non-zero on a blank canvas or any thrown exception. Use this to confirm rendering works after non-trivial changes to `BrainScene`, `NeuralGraph`, `BrainShell`, or the simulation/graph generator. Override the target with `VERIFY_URL=...`.

## Architecture

### The two layers the brain visualises

The repo carries **two parallel region taxonomies** — keep them straight when editing:

1. **Anatomical regions** — ~30 string-literal IDs in `src/engine/types.ts` (`BrainRegionId`) and `src/data/regionDefinitions.ts`. These drive what the user sees in the 3D scene. The renderer in `src/components/NeuralGraph.tsx` indexes everything by these IDs.
2. **Logical regions** — 8 high-level cortices defined in `shared/pipeline.ts` (`LogicalRegionId`: `memory-core`, `reasoning-cortex`, `project-cortex`, `file-memory`, `model-hub`, `response-center`, `error-detection-center`, `learning-feedback-center`). The server emits these in `PipelineEvent.logicalRegions`. The frontend maps each logical region onto a set of anatomical IDs via `src/engine/logicalRegions.ts` (`LOGICAL_REGION_MAP`) and flashes them in the scene.

Adding a new logical region means updating both `shared/pipeline.ts` (`LogicalRegionId` union + `LOGICAL_REGION_IDS` list) **and** `src/engine/logicalRegions.ts` (`LOGICAL_REGION_MAP` + labels). Adding a new anatomical region means updating `src/engine/types.ts` (`BrainRegionId`), `src/data/regionDefinitions.ts`, and the `REGION_CONNECTIONS` adjacency list in `src/engine/brainRegions.ts`.

### Rendering vs. React boundary (the core design choice)

The simulation state — `regionIntensity`, `pathwayIntensity`, and the `pulses` array on `SignalSimulation` — is **deliberately held outside React** as mutable Float32Arrays / a mutable array. React owns *config* (selected action, speed, density, visibility, shell opacity, camera preset); the render loop in `BrainScene` calls `simulation.step(delta, elapsed)` and then `graphRenderer.update(...)` every frame, mutating instance matrices and color buffers directly. **Do not lift per-frame simulation state into React state** — it would trigger re-renders at 60 Hz and defeat the whole architecture. When you need React to react to a config change, route it through one of the `simulation.setX(...)` methods (already wired in `BrainScene` effects).

### Frontend data flow

1. `App.tsx` holds all user-facing config in `useState` and passes it to `BrainScene`, `RegionControls`, `InfoPanel`, plus the auxiliary overlays (`PipelineOverlay`, `LogicalRegionIndicator`, `BrainOSPanel`, `AiCompanion`).
2. `BrainScene` (`src/components/BrainScene.tsx`) is the single Three.js host. One `useEffect` builds the scene/renderer/camera/controls/shell on mount. A separate effect, keyed on `neuronDensity`, rebuilds the `NeuralGraph` and swaps in a fresh `NeuralGraphRenderer` + `SignalSimulation`. Other props feed `simulation.setAction / setSpeed / setRunning`, `setBrainShellOpacity`, and `graphRenderer.applyRegionVisibility` through small effects — those don't tear down the scene.
3. The render loop reads refs (`visibilityRef`, `selectedRegionRef`) rather than closing over props so the single long-lived `renderFrame` keeps seeing the latest values without re-subscribing.
4. Region clicks come from raycasting against the invisible region volume meshes exposed as `graphRenderer.regionMeshes`; the hit's `userData.regionId` is sent back up via `onRegionSelect`.
5. `BrainScene` also subscribes to `brainBus` (the WS singleton, see below). When a `pipeline` message arrives, it expands `event.logicalRegions` through `LOGICAL_REGION_MAP` and flashes the resulting anatomical IDs.

### Engine layer (`src/engine/`)

- `types.ts` — all shared types. `BrainRegionId` and `BrainActionId` are string-literal unions.
- `brainRegions.ts` — derives `REGION_ORDER`, `REGION_INDEX`, `REGION_BY_ID`, `ACTION_BY_ID` lookup tables from the data file, and defines `REGION_CONNECTIONS` (inter-region edge counts) used by the graph generator.
- `logicalRegions.ts` — maps the 8 logical regions to anatomical IDs. Pure data file; no runtime dependencies.
- `neuralGraphGenerator.ts` — deterministic graph builder seeded by `density` (seed = `round(density*1000)+19` in `BrainScene`). Produces `NeuralGraph` with `nodes`, `pathways`, `regionRanges`, `regionOrder`, and a flat `nodePositions` Float32Array. Uses an O(n) sliding-window heuristic for intra-region locality rather than a true nearest-neighbor pass — keep that property if you change it.
- `signalSimulation.ts` — `SignalSimulation` owns the mutable intensity buffers and pulse list. `step()` decays intensities, spawns weighted pulses biased toward the active action's regions (`rebuildEligiblePathways` precomputes the eligible set on action change), advances each pulse along its pathway, and reflects pulse progress back into region/pathway intensity. `MAX_PULSES = 260` caps the active pool. Random number generation is seeded (mulberry32) so replays are deterministic.
- `apiClient.ts` — typed wrapper around the local `/api` surface. Default base URL `http://127.0.0.1:8787`, overridable with `VITE_BRAIN_API_URL`. Includes `ask()` which is an `async *` generator that parses the SSE stream from `POST /api/ask` and yields each `PipelineEvent`.
- `brainBus.ts` — singleton WebSocket client for `/ws/brain`. Backoff is 1s → 30s (doubling) with quiet logging — the first failure is logged, subsequent reminders are throttled to ~60s, and on a successful reconnect the backoff resets. The bus does **not** require the server to be up; it just keeps retrying. A `window.__brainBus.emit(...)` helper is exposed in dev for testing pipeline events without a backend.
- `ollamaClient.ts` / `aiCompanion.ts` / `audioBus.ts` / `speechInput.ts` / `speechOutput.ts` — the AI Companion path (separate from the server pipeline; talks directly to Ollama from the browser, lazy-loaded).

### Renderer details (`src/components/NeuralGraph.tsx`)

`NeuralGraphRenderer` packs all neurons into a single `InstancedMesh`, all pathways into one `LineSegments` with a per-vertex color `BufferGeometry`, and all pulses into a second `InstancedMesh`. Hiding a region is done by writing a zero-scale matrix for its neurons, not by toggling `visible` on individual meshes. Region volumes (the clickable hit-test shells) live in `regionMeshes` and are the only objects the raycaster intersects.

### Server (`server/src/`)

- `index.ts` — Express bootstrap. Opens the SQLite DB, ensures a default connector exists, kicks off connector probing (every 30s), wires the routers under `/api`, then attaches the WS hub via `attachBrainBus(server)`.
- `config.ts` — env-driven config (`PORT`, `HOST`, `DEFAULT_SCAN_ROOT`, `OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`, `EMBEDDING_DIM`, `MAX_FILES_PER_SCAN`, `MAX_FILE_BYTES`, `ALLOWED_ORIGIN`). Defaults are picked to work zero-config on the developer machine.
- `db/sqlite.ts` — opens `data/brain.sqlite` (WAL mode, FKs on), loads the `sqlite-vec` extension if available, and applies `db/schema.sql` on every boot (the schema is fully idempotent). The vec extension is **optional** — if `sqlite-vec` fails to load, the server keeps running and `vectorSearch` becomes a no-op; the frontend's `/api/health` reflects that as `vector: "unavailable"`.
- `db/schema.sql` — tables: `memory_points`, `memory_relations`, `conversations`, `messages`, `pipeline_runs`, `connectors`, `scan_roots`, `files`. The `memory_vec` virtual table is created at load time inside `loadVectorExtension` (it's the only schema piece that's *not* in `schema.sql`, because its existence depends on the extension loading).
- `db/repositories/` — one file per aggregate (`memory.ts`, `conversations.ts`, `connectors.ts`, `scan.ts`). Repositories return the typed shapes from `shared/memory.ts` and `shared/connector.ts`.
- `connectors/` — pluggable LLM connectors. `Connector.ts` defines the interface (`send`, `stream`, optional `embed`, `test`). Concrete impls: `OllamaConnector` (default), `OpenAIConnector`, plus stubs. `registry.ts` resolves the configured default.
- `reasoning/pipeline.ts` — the **7-step pipeline**: `input` → `memory` (embed + vector search + recency/importance boost) → `reasoning` (JSON plan) → `project` (project-name rerank) → `error` (contradictions/missing/confidence JSON) → `response` (streamed answer in three sections: `Known memory:` / `Inferred reasoning:` / `Uncertain:`) → `learning` (persist Q+A as a new `MemoryPoint`, link to cited memories). Each step calls `emitAll(...)` which **both** sends the event over SSE (to the originating request) and broadcasts it on the WS hub (to every subscribed tab). Markers in the answer have the form `[m:<id>]` and are validated against the set of memories actually retrieved — unknown IDs are stripped and a note is appended to the Uncertain section.
- `reasoning/prompts.ts` — system prompts for reasoning/project/error/response. The response prompt is parameterised by whether memory was found.
- `routes/` — Express routers, all mounted under `/api`: `health`, `memory`, `scan`, `connectors`, `ask` (SSE), `conversations`.
- `scanner/` — `walker` (recursive directory walk with ignore rules and budget caps), `chunker` (file → text chunks), `indexer` (chunk → `MemoryPoint` + embedding). The scan budget is `CONFIG.maxFilesPerScan` × `CONFIG.maxFileBytes` to keep an accidentally-pointed-at-`C:\` scan from spiralling.
- `ws/brainBus.ts` — WS hub at `/ws/brain`. Exports `broadcast(message)` which the pipeline and scanner call to fan out `BrainBusMessage`s.

### Tauri shell (`src-tauri/`)

Rust app that wraps the Vite build. `tauri.conf.json` sets `devUrl: "http://127.0.0.1:5173"` and `beforeDevCommand: "npm run dev"`, so `npm run tauri:dev` boots Vite for you. `src-tauri/src/lib.rs` registers commands defined in `commands.rs` (system metrics, project watch, git activity, brain activity, memory points, project context). The Rust DB (`database.rs`) is **separate** from the Node server's SQLite DB — it lives under the OS's app-data dir, not in `data/brain.sqlite`. If you're working on data that should be available to both the web app and the desktop shell, route through the Node server, not Tauri commands.

### Worker (`worker/`)

Phase 3 placeholder. Read `worker/README.md` before adding anything there — the intent is that Node calls a Python HTTP service for embedding/reranking once we outgrow Ollama embeddings, but **nothing routes through here in Phase 1 / Phase 2**. Don't add MVP dependencies on it.

## Purely-local guarantees

The project is designed to run end-to-end with **zero outbound network traffic** by default.

- **Server-enforced URL allowlist.** `server/src/config.ts` exposes `localOnly` (env `LOCAL_ONLY`, default `true`). When `true`, `POST /api/connectors` and `POST /api/connectors/select` reject any `baseUrl` whose host is not loopback (`127.0.0.1`, `localhost`, `::1`) or RFC1918 (`10/8`, `172.16/12`, `192.168/16`). The implementation is `isLocalUrl()` in `server/src/util/network.ts` — keep both inputs and outputs going through that helper.
- **Auto-discovery of local runtimes.** On boot and every 60 s, `reconcileDiscovered()` in `server/src/connectors/registry.ts` runs `discoverLocalRuntimes()` (in `server/src/connectors/discovery.ts`) which probes 7 known runtimes in parallel with content-checked probes and a 200 ms timeout per port: Ollama (11434), LM Studio (1234), llama.cpp (8080), Jan (1337), GPT4All (4891), vLLM (8000), TGI (3000). Detected runtimes are upserted as `auto-<kind>` rows; if no row is marked default, Ollama is preferred (native embeddings + streaming).
- **Tauri-side probe.** Browser fetches to non-:8787 ports get blocked by CORS preflight (these servers ship no CORS headers on loopback). The Rust command `probe_local_llms` in `src-tauri/src/llm_probe.rs` mirrors the Node-side probe table and is preferred when `window.__TAURI__` is present. If you change the probe table in either place, port the change to the other.
- **Unified OpenAI-compatible connector.** `server/src/connectors/OpenAICompatibleConnector.ts` drives LM Studio, llama.cpp, Jan, GPT4All, vLLM, and TGI through the OpenAI `/v1/*` endpoints. `embed()` is only attached when the descriptor sets `embeddingModel` — the pipeline's `getEmbedder()` helper relies on `instance.embed` presence rather than a no-op check.
- **Embeddings fallback chain.** `getEmbedder()` in `server/src/reasoning/pipeline.ts`: active connector → any local Ollama with `state: "ok"` → null (memory step degrades gracefully with `detail` ending in `"skipped"`). Pipelines on a chat-only runtime (e.g. GPT4All) still complete, just without retrieval-augmented citations.
- **`LocalityBadge` in the UI.** The status panel shows green "Purely local" when every enabled connector has `isLocal === true`, amber "Remote model in use" otherwise (the `/api/health` response carries `locality: "local" | "remote"`).
- **Strict Tauri CSP.** `src-tauri/tauri.conf.json` sets `default-src 'self'` with a `connect-src` that lists exactly the 7 runtime loopback URLs plus the local Node server. Anything else is blocked at the renderer.

To intentionally allow a remote endpoint: set `LOCAL_ONLY=false` in the server's `.env` and configure an OpenAI-compatible connector with the remote `baseUrl`. The `LocalityBadge` will flip to amber and list the offending URL.

## Conventions

- TypeScript `strict: true` is on in both `src/` and `server/`. The frontend build (`npm run build`) and the server `npm run typecheck` both fail on implicit `any` or unchecked nullables.
- React 18 with the automatic JSX runtime (`jsx: "react-jsx"`) — no `import React` needed.
- Three.js is imported as `import * as THREE from "three"`. Examples (`OrbitControls`, `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `GLTFLoader`) come from `three/examples/jsm/...`. Stay on the pinned version (`^0.171.0`) — examples sometimes break across minor releases.
- The server is ESM (`"type": "module"` in `server/package.json`). Relative imports inside `server/src/` must use the `.js` extension even when the source is `.ts` (Node ESM resolver requirement); imports of `shared/` use `.js` too, e.g. `from "../../../shared/pipeline.js"`.
- Shared types live in `shared/` and have **zero runtime dependencies** — they are pure type declarations + plain constants. Keep it that way so both the Vite client and the Node server can import them without a build step.
- `data/` (SQLite DB), `artifacts/` (screenshots), `dist/`, `worker/.venv/`, and `server/dist/` are all gitignored — assume they may not exist on a fresh checkout.
