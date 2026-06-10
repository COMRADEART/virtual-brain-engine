# worker/ — Phase 3 perception sidecar

Phase 1/2 of the Virtual Brain OS run entirely inside the Node server
(`server/`). Phase 3 (per `docs/VIRTUAL_BRAIN_ENGINE_BLUEPRINT.md` §17) wires
this Python sidecar for two perception capabilities that don't belong in
Node:

- **Speech → text** via [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper).
  Exposed at `POST /transcribe`; the server's perception router forwards to it
  on `POST /api/perceive/transcribe`.
- **Image → caption** via the BLIP image-captioning model (`transformers`).
  Exposed at `POST /caption`; forwarded on `POST /api/perceive/caption`.

> The MVP server keeps booting even when this process is **down**. The
> `WorkerClient` in `server/src/perception/workerClient.ts` probes `/healthz`
> on startup and degrades to `status: "down"` on failure, surfacing a
> diagnostic instead of crashing. Tabs that hit `/api/perceive/*` get a
> structured 503 with `detail: "worker offline"`; the rest of the pipeline is
> unaffected.

## Port

`127.0.0.1:8789`. The Civilization subsystem owns 8788 — do not change either
side without updating both.

## Running the scaffold (no ML, just `/healthz`)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py            # serves http://127.0.0.1:8789/healthz
```

`/healthz` reports `models.whisper` / `models.caption` as `"unavailable"`
without the ML deps. The server reflects that on `/api/perceive/status`.

## Running with perception enabled

```powershell
pip install -r requirements.txt -r requirements-ml.txt
python main.py
```

First call to `/transcribe` downloads the Whisper weights (tiny.en ≈ 75MB);
first call to `/caption` downloads BLIP base (≈ 990MB). Both warm in-process
on subsequent calls. After warming, `/healthz` reports the relevant model as
`"ready"`.

Env knobs:

| Variable               | Default                                       | Purpose                                  |
|------------------------|-----------------------------------------------|------------------------------------------|
| `WHISPER_MODEL_SIZE`   | `tiny.en`                                     | `tiny.en`/`base`/`small`/`medium`/`large` |
| `WHISPER_DEVICE`       | `cpu`                                         | `cuda` if a GPU + CUDA wheels are present|
| `WHISPER_COMPUTE_TYPE` | `int8`                                        | `float16` on GPU                         |
| `CAPTION_MODEL_ID`     | `Salesforce/blip-image-captioning-base`       | any BLIP-compatible HF model ID          |

## From-scratch LLM trainer (Learning Lab — Phase C)

`train/` is a small, faithful port of
[FareedKhan-dev/train-llm-from-scratch](https://github.com/FareedKhan-dev/train-llm-from-scratch):
the same GPT architecture (token + position embeddings, stacked causal
multi-head attention + MLP blocks, layer norm, residuals, AdamW with a cosine
LR schedule, cross-entropy) — but trained **from zero on the brain's own
memory corpus** instead of The Pile.

> **Honest scope.** A tiny model on a personal corpus (kilobytes–megabytes)
> learns the corpus's *texture* — its characters, words, and rhythms — not a
> capable assistant. The 13M-param source model is already only sentence-level
> coherent on 825GB; this is smaller, on far less data. It is an educational
> artifact, decoupled from the 7-step reasoning pipeline. It does **not** make
> the brain smarter or faster.

Two departures from the source, both because the corpus is tiny:

- **Char-level tokenizer** (`train/tokenizer.py`) instead of tiktoken — a 50k
  BPE vocab over a small corpus is mostly dead embeddings.
- **Tiny CPU defaults** (~0.4M params, 500 steps) — trains in
  seconds-to-minutes on CPU.

### Endpoints

| Method | Path            | Purpose                                                            |
|--------|-----------------|-------------------------------------------------------------------|
| `POST` | `/train/start`  | `{ corpus, steps?, force? }` — kick a background training thread.  |
| `GET`  | `/train/status` | Live `{ state, step, loss, valLoss, sample, params, … }`.          |

The **Node side ships the corpus** (`server/src/learning/llmTrainerClient.ts`
assembles it from SQLite via `exportMemoryCorpus()` and POSTs it) — the worker
never reaches back into Node. A single run is in flight at a time; pass
`force: true` to preempt. `torch` is imported lazily inside `/train/start`, so
the worker still boots (and `/train/status` reports `state: "unavailable"`)
without the ML deps.

Drive it from the UI: open the **Learning Lab** panel (bottom-left) and click
**Train from my memories**.

```powershell
pip install -r requirements.txt -r requirements-ml.txt   # torch
python main.py
```

## Beyond Phase 3 (not yet wired)

The earlier framing of this README also envisioned a sentence-transformers
`/embed` and a cross-encoder `/rerank` to replace the Ollama embedding path.
Those are still on the table for Phase 4 if vector recall quality plateaus —
the embedder fallback chain in `server/src/reasoning/pipeline.ts:getEmbedder()`
is the seam they would slot into.
