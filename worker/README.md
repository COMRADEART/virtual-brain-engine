# worker/ — Python sidecar (Phase 3 scaffold)

This directory is a placeholder for work that intentionally does **not** ship in
the MVP. The MVP backend is a single Node + Express + TypeScript process
(`server/`) that talks to Ollama for both chat and embeddings.

## What this is for (Phase 3)

When we outgrow Ollama-as-embedder, we'll move embedding + reranking into a
Python process so we can use sentence-transformers, cross-encoders, and other
HuggingFace models directly. Candidate responsibilities:

- `sentence-transformers/all-MiniLM-L6-v2` style embeddings (replaces
  Ollama `/api/embeddings` calls)
- Cross-encoder reranking after the SQLite vector recall step
- Episodic summarisation (compress old conversations into a single
  `MemoryPoint` with `source_type='manual'`)
- A local Chroma instance, if/when we decide SQLite + sqlite-vec is no longer
  enough

The protocol between Node and this worker will be plain HTTP — `POST /embed`,
`POST /rerank`, etc. Nothing routes through here in Phase 1 / Phase 2.

## Running the scaffold

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py            # serves http://127.0.0.1:8788/healthz
```

That's it for now. The MVP does not depend on this process being up.
