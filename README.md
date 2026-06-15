# Virtual Brain Engine

A **local-first personal AI brain** you can watch think. It pairs a real-time 3D neural
visualizer with a private reasoning server that remembers, retrieves, and answers — running
end-to-end on your own machine with **zero outbound network traffic by default**.

The brain runs against a local LLM (Ollama out of the box), stores everything in a single
SQLite file, and lights up an interactive 3D cortex in lock-step with every thought: as a
question flows through the reasoning pipeline, the regions doing the work flash in the scene.

> **Status:** active personal project, evolving fast. The MVP (visualizer + memory +
> 7-step reasoning pipeline) is solid; many of the advanced cognitive subsystems are
> experimental and gated behind flags. See [`CLAUDE.md`](CLAUDE.md) for the authoritative,
> exhaustive architecture map.

---

## What it does

- **Visualizes a living brain.** A transparent cortical shell rendered in Three.js with an
  interactive instanced neuron graph plus a GPU point-cloud field of up to **~1,000,000
  neurons**, synaptic pathways, and travelling signal pulses. Click a region to inspect it;
  the scene flashes the cortices that are active for each request.
- **Answers with grounded memory.** A **7-step reasoning pipeline** embeds your question,
  vector-searches your memories, plans, checks itself for contradictions, and streams an
  answer in three honest sections — *Known memory* / *Inferred reasoning* / *Uncertain* —
  with inline `[m:<id>]` citations validated against what was actually retrieved.
- **Learns from your machine.** Scan folders, upload any file (PDF / Office / images via
  caption), or learn from the web and popular GitHub repos — all governed by consent,
  redaction, and dedup, and all opt-in.
- **Acts, with permission.** A permissioned action layer can run real tasks on your computer
  (open files/URLs, run commands, launch apps) — every confirm-tier action is gated by an
  explicit confirm token or a granted session scope, and audited.
- **Stays private.** A server-enforced URL allowlist keeps the brain loopback-only unless you
  deliberately flip one flag. Remote LLMs and internet learning are an explicit opt-out, not
  the default.

---

## Architecture

This is a **multi-process project**, not just a Vite app. The cooperating pieces:

| Piece | Stack | Role |
| --- | --- | --- |
| `src/` | Vite + React 18 + Three.js | The 3D brain visualizer + Brain OS UI |
| `server/` | Express + TypeScript on `127.0.0.1:8787` | SQLite (`better-sqlite3` + `sqlite-vec`), Ollama connector, the 7-step reasoning pipeline, memory ML, agentic loop, WS/SSE broadcast |
| `shared/` | Pure TypeScript types | Contracts imported by both frontend and server (zero runtime deps) |
| `src-tauri/` | Tauri 2 (Rust) | Optional desktop shell that wraps the web app and bundles the server as a sidecar |
| `crates/` | 7 Rust crates | Phase 2 cognitive engines, built via the Tauri shell |
| `computer-brain/` | Separate Cargo workspace | A more ambitious local-first cognitive nervous system (independent build) |
| `worker/` | Python sidecar on `127.0.0.1:8789` | Optional ML: speech/image perception, from-scratch + LoRA model training, AirLLM inference |

The frontend and server talk over HTTP (`/api/...`), a single WebSocket (`/ws/brain`), and an
SSE stream on `POST /api/ask`. The SSE stream and the WS broadcast carry the same
`PipelineEvent` shape, so any open tab sees brain activity even if it didn't start the request.

### The 7-step reasoning pipeline

```
input → memory → reasoning → project → error → response → learning
```

`input` (parse) → `memory` (embed + vector search + recency/importance boost) → `reasoning`
(JSON plan) → `project` (project-name rerank) → `error` (contradiction / confidence check) →
`response` (streamed three-section answer) → `learning` (persist the Q+A as a new memory,
linked to the memories it cited). Each step both streams over SSE and broadcasts on the WS hub.

---

## Quick start

### Prerequisites

- **Node.js 22+** and npm.
- **[Ollama](https://ollama.com)** (recommended) for fully-local inference. Pull a chat model
  and the embedder:
  ```bash
  ollama pull llama3.2:3b
  ollama pull nomic-embed-text
  ```
  The server auto-discovers Ollama on `:11434` (and several other local runtimes — LM Studio,
  llama.cpp, Jan, GPT4All, vLLM, TGI). It still boots without any LLM; the pipeline just
  degrades gracefully.
- *(Optional)* Rust toolchain for the Tauri desktop build, and Python 3 for the ML worker.

### Install & run

```bash
npm install                 # frontend deps
npm install --prefix server # server deps

# Run the Vite app and the reasoning server together:
npm run dev:all
```

- Frontend: <http://127.0.0.1:5173>
- Server API: <http://127.0.0.1:8787> (creates `data/brain.sqlite` on first run)

Run them separately if you prefer: `npm run dev` (frontend only) and `npm run dev:server`
(server only). The visualizer renders without the server — it just won't have a brain to
flash for.

### Build

```bash
npm run build     # tsc type-check (noEmit) then vite build
```

---

## Configuration & privacy

The server reads `.env` from the repo root and is designed to run **zero-config on a local
machine**. Defaults are picked so the whole thing works offline.

| Env var | Default | What it does |
| --- | --- | --- |
| `LOCAL_ONLY` | `true` | **The privacy switch.** When true, the server refuses any connector/web/MCP URL whose host isn't loopback or RFC1918 — nothing leaves the machine. Set `false` to allow remote LLMs and internet learning (the UI then shows an amber "Remote model in use" badge). |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint. |
| `OLLAMA_CHAT_MODEL` | `llama3.2:3b` | Chat model. |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model (`EMBEDDING_DIM` 768). |
| `OLLAMA_NUM_CTX` | `8192` | Context-window cap. Prevents a model with a huge default context from overflowing a small GPU's VRAM and hanging. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Server bind address. |
| `ALLOW_SHELL` | `true` | Exposes the confirm-tier `run-command` / `launch-app` actions (still fully gated + audited). |
| `WEB_SEARCH_MODE` | `smart` | When `/api/ask` reaches the web (only ever with `LOCAL_ONLY=false`). |
| `CIVILIZATION_ENABLED` | `false` | The experimental P2P "civilization" subsystem (binds extra sockets). |

Secrets (API keys) live only in `.env` (gitignored) and are read from `process.env` at request
time — never persisted to the database. A curated subset of these knobs is also editable live
from the UI's **Settings → Brain** panel.

**Going hybrid (local + internet):** set `LOCAL_ONLY=false`, then configure a search backend
(`WEB_SEARCH_PROVIDER` with `SEARXNG_URL` or a `BRAVE_API_KEY` / `TAVILY_API_KEY` /
`EXA_API_KEY`; falls back to keyless DuckDuckGo) and/or a remote OpenAI-compatible connector.
The two curated free-tier providers (NVIDIA NIM, Google Gemini) are reachable even under
`LOCAL_ONLY=true` because their exact hosts are allowlisted — just set the key.

---

## Repository layout

```
src/             React + Three.js visualizer and Brain OS UI
  engine/        Simulation, neural graph generator, signal sim, API/WS clients
  components/    BrainScene, NeuralGraph, NeuronField, panels, the desktop pet
server/src/      Express server
  reasoning/     The 7-step pipeline, prompts, ranker, agent loop
  memory/        Memory ML: importance, consolidation, novelty, sleep, episodes
  db/            SQLite schema + repositories
  routes/        REST routers mounted under /api
  connectors/    Ollama + OpenAI-compatible connectors, local-runtime discovery
  actions/ ingest/ web/ github/ spine/ mcp/   FRIDAY command + learning layers
shared/          Pure-TypeScript type contracts
src-tauri/       Tauri 2 desktop shell (Rust)
crates/          Phase 2 Rust cognitive engines
computer-brain/  Separate Cargo workspace (independent cognitive system)
worker/          Python ML sidecar (perception, training, AirLLM)
docs/            Architecture specs and roadmaps
```

---

## Testing & quality gate

There's a hermetic CI gate plus a runtime verification ritual (a green gate boots the server
but **no** LLM, so render/cognition changes need a matching runtime check).

```bash
npm run gate            # typecheck + every backend selfcheck + server smoke (CI runs this)
npm run test:unit       # Vitest unit suite
npm run verify:canvas   # headless check that the 3D scene actually draws (needs dev server up)
npm run test:all        # boots Vite for you, runs the canvas + action smoke checks, tears down
```

The server ships dozens of hermetic `*:selfcheck` scripts (one per subsystem; see
`server/package.json` and `scripts/gate.mjs`). `.github/workflows/gate.yml` runs the full gate
on every push/PR; `nightly-live.yml` runs the live `/api/ask` smoke against a real Ollama model.

---

## Desktop app (Tauri)

```bash
npm run tauri:dev       # builds the server sidecar bundle, then runs Vite + the Rust shell
npm run tauri:build     # production installer (msi/nsis on Windows)
```

The desktop build is **one-app mode**: it esbuild-bundles the Node server into the app and
spawns/supervises it at runtime, with a strict CSP that allows only the local runtime
endpoints. The Python ML worker is not bundled — everything degrades gracefully without it.

---

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — the full, authoritative architecture map (read this first for deep work).
- [`docs/`](docs/) — design specs and roadmaps (`PHASE2_ARCHITECTURE.md`,
  `CIVILIZATION_ARCHITECTURE.md`, `COGNITIVE_LOOP_ROADMAP.md`, `NEUROSCIENCE_MODULES.md`, …).
- [`SPEC.md`](SPEC.md), [`PERSONAL_MEMORY_BRAIN_SPEC.md`](PERSONAL_MEMORY_BRAIN_SPEC.md),
  [`DIGITAL_TWIN_SPEC.md`](DIGITAL_TWIN_SPEC.md) — forward-looking direction (read for *why*;
  read the code for *what is*).
