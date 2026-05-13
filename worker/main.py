"""Virtual Brain OS worker sidecar (Phase 3 scaffold).

This FastAPI app is intentionally minimal. The MVP runs entirely inside the
Node + Express server; the worker is reserved for Phase 3 work where local
heavyweight models (sentence-transformers reranking, summary generation,
classification) belong out-of-process. See worker/README.md.

The /healthz endpoint exists so the MVP server can probe whether a worker
is running without coupling its boot to the sidecar.
"""
from __future__ import annotations

from fastapi import FastAPI

app = FastAPI(title="virtual-brain-worker", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "role": "phase-3-scaffold"}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8788)
