"""Virtual Brain OS worker sidecar — Phase 3 perception layer.

This FastAPI app exposes the perception endpoints the Node server consumes
under /api/perceive/*. Two design constraints are deliberate:

  1. The MVP server must still boot with this process down. Every endpoint
     here is optional from the server's point of view; the server's worker
     client degrades to status="down" and surfaces a diagnostic instead of
     crashing the pipeline.

  2. The heavy ML deps (faster-whisper, transformers, torch, pillow) are
     OPTIONAL. They live in requirements-ml.txt, not requirements.txt. This
     module imports them LAZILY inside the request handlers so the bare
     /healthz scaffold runs anywhere FastAPI does. The /healthz response
     reports per-feature availability ("ready" once a model is warm,
     "available" if importable, "unavailable" if the dep is missing) so the
     server can surface that to the UI.

Port: 127.0.0.1:8789. The Civilization subsystem already owns 8788; do not
move back without updating server/src/civilization/index.ts in lockstep.
"""
from __future__ import annotations

import base64
import importlib.util
import io
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="virtual-brain-worker", version="0.2.0")

_START_TS = time.monotonic()

# ---------------------------------------------------------------------------
# Capability probe — what's installed, what's warm.
# ---------------------------------------------------------------------------

# Model state lives at module scope so a /healthz call can report "ready" once
# the underlying model has been loaded by an earlier request. Cold restart =
# every model goes back to "available" until first call. The server tolerates
# any state — only the route that needs the missing model 503s.
_warm: dict[str, bool] = {"whisper": False, "caption": False}


def _model_state(feature: Literal["whisper", "caption"]) -> Literal["ready", "available", "unavailable"]:
    if _warm.get(feature):
        return "ready"
    # importlib.util.find_spec is cheap (filesystem only); avoids importing the
    # actual heavy module just to answer a probe.
    deps = {
        "whisper": ("faster_whisper",),
        "caption": ("transformers", "PIL"),
    }[feature]
    for mod in deps:
        if importlib.util.find_spec(mod) is None:
            return "unavailable"
    return "available"


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "status": "ok",
        "role": "phase-3-perception",
        "uptimeSec": time.monotonic() - _START_TS,
        "version": app.version,
        "models": {
            "whisper": _model_state("whisper"),
            "caption": _model_state("caption"),
        },
    }


# ---------------------------------------------------------------------------
# /transcribe — audio -> text (faster-whisper).
# ---------------------------------------------------------------------------


class TranscribeIn(BaseModel):
    audioBase64: str = Field(..., description="Base64-encoded audio bytes.")
    mimeType: str | None = None
    language: str | None = None


_whisper_model: Any | None = None
# WHISPER_MODEL_SIZE controls the model identifier. tiny.en is the fastest
# CPU-only English option; switch to "base" / "small" via env when accuracy
# becomes the bottleneck.
_WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "tiny.en")
_WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
_WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")


def _load_whisper() -> Any:
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "faster-whisper not installed. Install worker/requirements-ml.txt "
                "to enable transcription."
            ),
        ) from exc
    _whisper_model = WhisperModel(
        _WHISPER_MODEL_SIZE,
        device=_WHISPER_DEVICE,
        compute_type=_WHISPER_COMPUTE_TYPE,
    )
    _warm["whisper"] = True
    return _whisper_model


@app.post("/transcribe")
def transcribe(body: TranscribeIn) -> dict[str, Any]:
    try:
        raw = base64.b64decode(body.audioBase64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"audioBase64 decode failed: {exc}") from exc

    model = _load_whisper()
    started = time.perf_counter()
    # faster-whisper consumes a file-like object directly; no temp file needed.
    audio_stream = io.BytesIO(raw)
    segments_iter, info = model.transcribe(
        audio_stream,
        language=body.language,
        vad_filter=True,
    )
    segments = [
        {"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip()}
        for seg in segments_iter
    ]
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    text = " ".join(s["text"] for s in segments).strip()
    return {
        "text": text,
        "language": getattr(info, "language", None),
        "segments": segments,
        "latencyMs": elapsed_ms,
        "model": f"faster-whisper:{_WHISPER_MODEL_SIZE}",
    }


# ---------------------------------------------------------------------------
# /caption — image -> caption (BLIP via transformers).
# ---------------------------------------------------------------------------


class CaptionIn(BaseModel):
    imageBase64: str = Field(..., description="Base64-encoded image bytes (png/jpg/webp).")
    prompt: str | None = Field(
        default=None,
        description="Optional conditioning prompt (BLIP supports prefix-conditioned captions).",
    )


_caption_processor: Any | None = None
_caption_model: Any | None = None
_CAPTION_MODEL_ID = os.environ.get("CAPTION_MODEL_ID", "Salesforce/blip-image-captioning-base")


def _load_caption() -> tuple[Any, Any]:
    global _caption_processor, _caption_model
    if _caption_processor is not None and _caption_model is not None:
        return _caption_processor, _caption_model
    try:
        from transformers import BlipProcessor, BlipForConditionalGeneration  # type: ignore[import-not-found]
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "transformers not installed. Install worker/requirements-ml.txt to "
                "enable image captioning."
            ),
        ) from exc
    _caption_processor = BlipProcessor.from_pretrained(_CAPTION_MODEL_ID)
    _caption_model = BlipForConditionalGeneration.from_pretrained(_CAPTION_MODEL_ID)
    _warm["caption"] = True
    return _caption_processor, _caption_model


@app.post("/caption")
def caption(body: CaptionIn) -> dict[str, Any]:
    try:
        raw = base64.b64decode(body.imageBase64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"imageBase64 decode failed: {exc}") from exc
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="Pillow not installed. Install worker/requirements-ml.txt.",
        ) from exc

    processor, model = _load_caption()
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    started = time.perf_counter()
    if body.prompt:
        inputs = processor(image, body.prompt, return_tensors="pt")
    else:
        inputs = processor(image, return_tensors="pt")
    out = model.generate(**inputs, max_new_tokens=40)
    text = processor.decode(out[0], skip_special_tokens=True).strip()
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    return {
        "caption": text,
        # BLIP's generate() doesn't expose calibrated confidence; leave null
        # rather than fabricate one.
        "confidence": None,
        "latencyMs": elapsed_ms,
        "model": _CAPTION_MODEL_ID,
    }


# ---------------------------------------------------------------------------
# /train/* — from-scratch LLM trainer (Learning Lab — Phase C).
#
# Trains a tiny GPT from ZERO on the brain's own memory corpus (shipped by the
# Node side in the request body). Honest scope: this learns the corpus's
# texture, not a capable assistant. torch is imported LAZILY inside /train/start
# so the worker still boots without ML deps — exactly like the perception models.
# ---------------------------------------------------------------------------

_train_lock = threading.Lock()
_train_thread: threading.Thread | None = None
# Keys mirror shared/learning.LlmTrainerStatus so the Node client maps 1:1.
_train_status: dict[str, Any] = {
    "state": "idle",
    "step": 0,
    "totalSteps": 0,
    "loss": None,
    "valLoss": None,
    "sample": None,
    "vocabSize": None,
    "params": None,
    "corpusChars": None,
    "message": None,
    "updatedAt": None,
}

_MIN_CORPUS_CHARS = 1000


class TrainIn(BaseModel):
    corpus: str = Field(..., description="Training corpus — the brain's own memories.")
    steps: int | None = Field(default=None, ge=1, le=100_000)
    force: bool = Field(default=False, description="Restart even if a run is in progress.")


@app.get("/train/status")
def train_status() -> dict[str, Any]:
    out = dict(_train_status)
    # A booted worker WITHOUT torch can't train — report that honestly rather
    # than sitting at "idle" forever. Once a run has happened the real state
    # (running/done/error) takes precedence.
    if out["state"] == "idle" and importlib.util.find_spec("torch") is None:
        out["state"] = "unavailable"
        out["message"] = "torch not installed — pip install -r requirements-ml.txt"
    return out


@app.post("/train/start")
def train_start(body: TrainIn) -> dict[str, Any]:
    global _train_thread
    # Lazy import — torch (and the trainer) only load here.
    try:
        from train.trainer import run_training
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"torch not installed ({exc}). Install worker/requirements-ml.txt to train.",
        ) from exc

    if len(body.corpus) < _MIN_CORPUS_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"corpus too small to train ({len(body.corpus)} chars, need >= {_MIN_CORPUS_CHARS}).",
        )

    with _train_lock:
        # Single in-flight run, enforced on THREAD LIVENESS (not the status
        # string). A live thread owns _train_status; spawning a second would
        # race writes into the same dict. We can't safely kill a Python thread,
        # so force can't preempt a live run — it only lets a NEW run start when
        # a previous thread has died but left a stale "running" status.
        if _train_thread is not None and _train_thread.is_alive():
            out = dict(_train_status)
            if body.force:
                out["message"] = "a training run is already in flight — force ignored until it finishes"
            return out
        _train_status.update(
            state="running",
            step=0,
            totalSteps=body.steps or 0,
            loss=None,
            valLoss=None,
            sample=None,
            vocabSize=None,
            params=None,
            corpusChars=len(body.corpus),
            message="starting…",
            updatedAt=datetime.now(timezone.utc).isoformat(),
        )
        thread = threading.Thread(
            target=run_training,
            args=(body.corpus, _train_status, body.steps),
            daemon=True,
        )
        _train_thread = thread
        thread.start()

    return dict(_train_status)


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8789)
