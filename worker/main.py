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
_warm: dict[str, bool] = {"whisper": False, "caption": False, "omniparser": False, "tts": False}


def _model_state(
    feature: Literal["whisper", "caption", "omniparser", "tts"],
) -> Literal["ready", "available", "unavailable"]:
    if _warm.get(feature):
        return "ready"
    deps = {
        "whisper": ("faster_whisper",),
        "caption": ("transformers", "PIL"),
        "omniparser": ("ultralytics", "transformers", "PIL"),
        # Bark (Suno's open TTS) — requires torch + transformers + scipy + bark.
        "tts": ("torch", "transformers", "scipy", "bark"),
    }[feature]
    for mod in deps:
        if importlib.util.find_spec(mod) is None:
            return "unavailable"
    return "available"


def _airllm_health() -> str:
    """airllm capability for /healthz: the live engine state once a run has
    happened, else availability by dep presence. Safe on a bare worker — the
    engine module top level imports stdlib only."""
    try:
        from airllm_engine.engine import status_snapshot

        snap = status_snapshot()
        state = snap.get("state")
        if state not in (None, "idle"):
            return str(state)
    except Exception:  # noqa: BLE001 — fall through to dep probe
        pass
    return "unavailable" if importlib.util.find_spec("airllm") is None else "available"


# turbovec — optional alternative vector index (TurboQuant, ~16x compression at
# 2-bit, SIMD ARM/x86). In-memory IdMapIndex keyed by memory_points.embedding_id
# (the memory_vec rowid) so the Node-side post-search join mirrors sqlite-vec
# exactly. OFF by default — only used when the server's CONFIG.turbovecEnabled is
# true. The Node backfill route seeds it from the existing sqlite-vec store, the
# ingestion mirror keeps it warm, and write()/load() persist it across worker
# restarts. See memory/turbovec-deferred.md for the scale-based rationale.
_turbovec_index: Any | None = None
_turbovec_dim: int | None = None
_turbovec_bit_width: int = 4
_turbovec_count: int = 0
_turbovec_path: str = os.environ.get(
    "TURBOVEC_INDEX_PATH",
    os.path.join(os.getcwd(), "data", "turbovec_index.tvim"),
)
_turbovec_lock = threading.Lock()


def _turbovec_health() -> str:
    """turbovec capability for /healthz: 'ready' once an index is loaded, else
    availability by dep presence (turbovec + numpy). Safe on a bare worker — only
    stdlib + importlib are touched here, no optional dep is imported."""
    if _turbovec_index is not None:
        return "ready"
    if (
        importlib.util.find_spec("turbovec") is None
        or importlib.util.find_spec("numpy") is None
    ):
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
            "omniparser": _model_state("omniparser"),
            "tts": _model_state("tts"),
            "airllm": _airllm_health(),
            "turbovec": _turbovec_health(),
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
# /perceive/frame — screen frame -> structured UI elements + OCR (OmniParser V2).
#
# OmniParser V2 = a YOLO icon/element detector (ultralytics) + a Florence2
# caption model (transformers/PIL). Both need torch, so this endpoint is the
# "frame" analogue of /caption: the deps are OPTIONAL + imported LAZILY, and a
# missing dep -> 503 (exactly like _load_caption). We never download weights at
# import time. The real model wiring below is a best-effort sketch — without
# torch it never executes — but it's lazy and plausible so installing
# requirements-ml.txt lights it up.
# ---------------------------------------------------------------------------


class FrameIn(BaseModel):
    imageBase64: str = Field(..., description="Base64-encoded screen-frame bytes (png/jpg/webp).")
    ocr: bool = Field(default=True, description="Run OCR over the frame.")


_omni_yolo: Any | None = None
_omni_caption: Any | None = None
_OMNI_YOLO_WEIGHTS = os.environ.get("OMNIPARSER_YOLO_WEIGHTS", "icon_detect/model.pt")
_OMNI_CAPTION_MODEL_ID = os.environ.get("OMNIPARSER_CAPTION_MODEL_ID", "microsoft/Florence-2-base")


def _load_omniparser() -> tuple[Any, Any]:
    """Lazy-load the OmniParser detector + caption model.

    Raises HTTPException(503) when ultralytics / transformers / PIL aren't
    installed — same contract as _load_caption / _load_whisper. The weights
    are only loaded here (first call), never at import time.
    """
    global _omni_yolo, _omni_caption
    if _omni_yolo is not None and _omni_caption is not None:
        return _omni_yolo, _omni_caption
    try:
        from ultralytics import YOLO  # type: ignore[import-not-found]
        from transformers import (  # type: ignore[import-not-found]
            AutoModelForCausalLM,
            AutoProcessor,
        )
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "OmniParser deps not installed. Install worker/requirements-ml.txt "
                "to enable frame parsing."
            ),
        ) from exc
    _omni_yolo = YOLO(_OMNI_YOLO_WEIGHTS)
    processor = AutoProcessor.from_pretrained(_OMNI_CAPTION_MODEL_ID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(_OMNI_CAPTION_MODEL_ID, trust_remote_code=True)
    _omni_caption = (processor, model)
    _warm["omniparser"] = True
    return _omni_yolo, _omni_caption


_INTERACTABLE_TYPES = {"icon", "button"}


@app.post("/perceive/frame")
def perceive_frame(body: FrameIn) -> dict[str, Any]:
    try:
        raw = base64.b64decode(body.imageBase64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"imageBase64 decode failed: {exc}") from exc
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "OmniParser deps not installed. Install worker/requirements-ml.txt "
                "to enable frame parsing."
            ),
        ) from exc

    yolo, (processor, caption_model) = _load_omniparser()
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    started = time.perf_counter()

    # --- Element detection (YOLO) ------------------------------------------
    elements: list[dict[str, Any]] = []
    detections = yolo(image, verbose=False)
    for det in detections:
        boxes = getattr(det, "boxes", None)
        if boxes is None:
            continue
        for box in boxes:
            # xywh: center-x, center-y, w, h -> convert to top-left x, y.
            cx, cy, w, h = (float(v) for v in box.xywh[0].tolist())
            x = int(cx - w / 2)
            y = int(cy - h / 2)
            cls_idx = int(box.cls[0]) if getattr(box, "cls", None) is not None else 0
            elem_type = yolo.names.get(cls_idx, "icon") if hasattr(yolo, "names") else "icon"
            if elem_type not in ("icon", "text", "button"):
                elem_type = "icon"
            # Per-element caption via Florence2 over the crop.
            crop = image.crop((x, y, x + int(w), y + int(h)))
            inputs = processor(text="<CAPTION>", images=crop, return_tensors="pt")
            out = caption_model.generate(**inputs, max_new_tokens=24)
            caption_text = processor.batch_decode(out, skip_special_tokens=True)[0].strip()
            elements.append(
                {
                    "bbox": [x, y, int(w), int(h)],
                    "type": elem_type,
                    "interactable": elem_type in _INTERACTABLE_TYPES,
                    "caption": caption_text,
                }
            )

    # --- Whole-frame OCR (Florence2 OCR task) ------------------------------
    ocr_text = ""
    if body.ocr:
        inputs = processor(text="<OCR>", images=image, return_tensors="pt")
        out = caption_model.generate(**inputs, max_new_tokens=256)
        ocr_text = processor.batch_decode(out, skip_special_tokens=True)[0].strip()

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    return {
        "elements": elements,
        "ocrText": ocr_text,
        "latencyMs": elapsed_ms,
        "model": "omniparser-v2",
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
    "device": None,
    "checkpointPath": None,
    "message": None,
    "updatedAt": None,
}

_MIN_CORPUS_CHARS = 1000


class TrainIn(BaseModel):
    corpus: str = Field(..., description="Training corpus — the brain's own memories.")
    steps: int | None = Field(default=None, ge=1, le=100_000)
    force: bool = Field(default=False, description="Restart even if a run is in progress.")


def _scratch_ckpt_path() -> str | None:
    # Mirrors train.trainer.checkpoint_path() WITHOUT importing the trainer —
    # that module imports torch at top level and this must stay callable on a
    # bare worker.
    root = os.environ.get("SCRATCH_LLM_OUT", os.path.join("data", "scratchllm"))
    p = os.path.abspath(os.path.join(root, "model.pt"))
    v = os.path.abspath(os.path.join(root, "vocab.json"))
    return p if os.path.exists(p) and os.path.exists(v) else None


@app.get("/train/status")
def train_status() -> dict[str, Any]:
    out = dict(_train_status)
    # A booted worker WITHOUT torch can't train — report that honestly rather
    # than sitting at "idle" forever. Once a run has happened the real state
    # (running/done/error) takes precedence.
    if out["state"] == "idle" and importlib.util.find_spec("torch") is None:
        out["state"] = "unavailable"
        out["message"] = "torch not installed — pip install -r requirements-ml.txt"
    # A restarted worker forgets the in-memory status, but a previously trained
    # model persists on disk — report it so the UI knows the brain HAS a model.
    if out["checkpointPath"] is None:
        out["checkpointPath"] = _scratch_ckpt_path()
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
            device=None,
            checkpointPath=None,
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


class GenerateIn(BaseModel):
    prompt: str = Field(default="", max_length=4000)
    maxNewTokens: int = Field(default=200, ge=1, le=2000)
    temperature: float = Field(default=0.8, gt=0.0, le=2.0)


@app.post("/train/generate")
def train_generate(body: GenerateIn) -> dict[str, Any]:
    """Sample from the persisted from-scratch brain model (CPU — never contends
    with an in-flight training run for VRAM). 404 until a model has been trained."""
    try:
        from train.trainer import generate_text
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"torch not installed ({exc}). Install worker/requirements-ml.txt.",
        ) from exc
    try:
        return generate_text(
            prompt=body.prompt,
            max_new_tokens=body.maxNewTokens,
            temperature=body.temperature,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# /voice/speak — text -> speech (Bark / Suno open TTS).
#
# Bark (https://github.com/suno-ai/bark) is a neural TTS model producing natural
# prosody and voice characteristics. Voice presets are hard-coded speaker IDs;
# a future iteration could accept a speaker reference for voice cloning.
# All deps are lazy — torch/transformers/scipy are imported ONLY inside the
# handler so the worker still boots without ML deps.
# ---------------------------------------------------------------------------


class VoiceIn(BaseModel):
    text: str = Field(..., description="Text to synthesize.")
    voice: str | None = Field(
        default="v2/en_speaker_6",
        description="Bark voice preset (e.g. v2/en_speaker_6, v2/en_speaker_0).",
    )
    # "sculpt" = moderate post-processing (Bark default); "sharp" = crisper
    # onsets; "neutral" = minimal processing.
    preset: str = Field(default="sculpt")


_tts_model: Any | None = None


@app.post("/voice/speak")
def voice_speak(body: VoiceIn) -> dict[str, Any]:
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text cannot be empty.")

    try:
        from bark import SAMPLE_RATE, generate_audio  # type: ignore[import-not-found]
        from scipy.io.wavfile import write as write_wav  # type: ignore[import-not-found]
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="bark not installed. Install worker/requirements-ml.txt to enable voice synthesis.",
        ) from exc

    _warm["tts"] = True
    started = time.perf_counter()

    voice = body.voice or "v2/en_speaker_6"
    audio_array = generate_audio(
        text_prompt=body.text[:1000],
        history_prompt=voice,
        text_temp=0.7,
        waveform_temp=0.7,
    )

    import numpy as np  # type: ignore[import-not-found]

    audio_int16 = np.array(audio_array * 32767, dtype=np.int16)
    wav_io = io.BytesIO()
    write_wav(wav_io, SAMPLE_RATE, audio_int16)
    wav_io.seek(0)
    audio_b64 = base64.b64encode(wav_io.read()).decode()

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    return {
        "audioBase64": audio_b64,
        "mimeType": "audio/wav",
        "sampleRate": SAMPLE_RATE,
        "durationSec": round(len(audio_array) / SAMPLE_RATE, 2),
        "latencyMs": elapsed_ms,
        "model": "bark",
        "voice": voice,
    }


# ---------------------------------------------------------------------------
# /ownmodel/* — the brain's OWN model (Learning Lab — Phase D: own-LLM).
# ---------------------------------------------------------------------------

_ownmodel_lock = threading.Lock()
_ownmodel_thread: threading.Thread | None = None
# Keys mirror shared/learning.OwnModelStatus so the Node client maps 1:1.
_ownmodel_status: dict[str, Any] = {
    "state": "idle",
    "step": 0,
    "totalSteps": 0,
    "loss": None,
    "baseModel": None,
    "outputDir": None,
    "ggufPath": None,
    "modelName": None,
    "served": False,
    "corpusChars": None,
    "trainableParams": None,
    "device": None,
    "message": None,
    "updatedAt": None,
}

_OWN_MIN_CORPUS_CHARS = 1000


class OwnModelIn(BaseModel):
    corpus: str = Field(..., description="Training corpus — the brain's own memories.")
    steps: int | None = Field(default=None, ge=1, le=100_000)
    baseModel: str | None = Field(default=None, description="HF base model id to adapt.")
    force: bool = Field(default=False, description="Restart even if a run is in progress.")
    distill: bool = Field(
        default=False,
        description="Distill the corpus through a high-parameter airllm teacher before training.",
    )
    teacherModel: str | None = Field(
        default=None, description="HF id of the airllm distillation teacher (e.g. Qwen/Qwen2.5-7B-Instruct)."
    )


def _ownmodel_deps_ok() -> bool:
    return all(
        importlib.util.find_spec(mod) is not None for mod in ("torch", "transformers", "peft")
    )


@app.get("/ownmodel/status")
def ownmodel_status() -> dict[str, Any]:
    out = dict(_ownmodel_status)
    # A booted worker WITHOUT the training deps can't build an own-model — report
    # that honestly rather than sitting at "idle". Once a run has happened the
    # real state (running/merging/done/error) takes precedence.
    if out["state"] == "idle" and not _ownmodel_deps_ok():
        out["state"] = "unavailable"
        out["message"] = "torch/transformers/peft not installed — pip install -r requirements-ml.txt"
    return out


@app.post("/ownmodel/start")
def ownmodel_start(body: OwnModelIn) -> dict[str, Any]:
    global _ownmodel_thread
    # Lazy import — torch/transformers/peft (and the trainer) only load here.
    try:
        from finetune.trainer import run_finetune
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                f"own-model training deps not installed ({exc}). "
                "Install worker/requirements-ml.txt to build the brain's own model."
            ),
        ) from exc

    if len(body.corpus) < _OWN_MIN_CORPUS_CHARS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"corpus too small to train ({len(body.corpus)} chars, "
                f"need >= {_OWN_MIN_CORPUS_CHARS})."
            ),
        )

    with _ownmodel_lock:
        # Single in-flight run, enforced on THREAD LIVENESS — same rationale as
        # /train/start: we can't safely kill a Python thread, so a live run owns
        # the status dict and force can't preempt it.
        if _ownmodel_thread is not None and _ownmodel_thread.is_alive():
            out = dict(_ownmodel_status)
            if body.force:
                out["message"] = "an own-model run is already in flight — force ignored until it finishes"
            return out
        _ownmodel_status.update(
            state="running",
            step=0,
            totalSteps=body.steps or 0,
            loss=None,
            baseModel=body.baseModel,
            outputDir=None,
            ggufPath=None,
            modelName=None,
            served=False,
            corpusChars=len(body.corpus),
            trainableParams=None,
            device=None,
            message="starting…",
            updatedAt=datetime.now(timezone.utc).isoformat(),
        )
        thread = threading.Thread(
            target=run_finetune,
            args=(
                body.corpus,
                _ownmodel_status,
                body.steps,
                body.baseModel,
                body.teacherModel,
                body.distill,
            ),
            daemon=True,
        )
        _ownmodel_thread = thread
        thread.start()

    return dict(_ownmodel_status)


# ---------------------------------------------------------------------------
# /airllm/* — high-parameter inference via AirLLM (layer-by-layer offloading).
#
# Runs a LARGE model (7B…70B) on a small GPU by streaming one transformer layer
# at a time. Inference-only + SLOW; used for occasional high-quality generation
# and as the distillation teacher for the mango own-model trainer. airllm/torch
# are imported lazily inside the engine, so the worker still boots without them
# (/airllm/status -> "unavailable").
# ---------------------------------------------------------------------------


class AirllmGenerateIn(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=8000)
    model: str | None = Field(default=None, description="HF model id (default AIRLLM_TEACHER_MODEL).")
    maxNewTokens: int = Field(default=256, ge=1, le=2048)
    compression: str | None = Field(default=None, description="'4bit' | '8bit' | 'off'.")


@app.get("/airllm/status")
def airllm_status() -> dict[str, Any]:
    from airllm_engine.engine import status_snapshot

    out = status_snapshot()
    if out.get("state") == "idle" and importlib.util.find_spec("airllm") is None:
        out["state"] = "unavailable"
        out["message"] = "airllm not installed — pip install -r requirements-ml.txt"
    return out


@app.post("/airllm/generate")
def airllm_generate(body: AirllmGenerateIn) -> dict[str, Any]:
    from airllm_engine.engine import AirllmUnavailable, generate

    try:
        result = generate(
            prompt=body.prompt,
            max_new_tokens=body.maxNewTokens,
            model_id=body.model,
            compression=body.compression,
        )
        return {"ok": True, **result}
    except AirllmUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                f"airllm not installed ({exc}). Install worker/requirements-ml.txt "
                "to run high-parameter inference."
            ),
        ) from exc
    except Exception as exc:  # noqa: BLE001 — surface a clean 500, never crash
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc


# ---------------------------------------------------------------------------
# turbovec index service — /vector/* (status / add / add_batch / search / clear).
# Lazy import of turbovec + numpy (the deps live in requirements-ml.txt). The index
# is created empty on first add (dim taken from the first vector's length), loaded
# from disk on first use if a persisted .tvim file exists, and re-written after
# every mutation. A missing dep → 503; any other failure → a clean 500, never crash.
# ---------------------------------------------------------------------------


def _turbovec_safe_count(index: Any) -> int:
    """Best-effort vector count (IdMapIndex may expose __len__ or a count attr).
    Returns 0 if neither is available — a UI nicety, not correctness."""
    try:
        return int(len(index))  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        pass
    try:
        return int(getattr(index, "count", 0))
    except Exception:  # noqa: BLE001
        return 0


def _turbovec_load_if_present() -> None:
    """Best-effort load of a persisted index into memory so /vector/status reports
    'ready' immediately after a worker restart. No-op if already loaded, no file,
    or the dep is missing. Never raises — a load failure stays at 'available'/
    'unavailable' and the next /vector/add rebuilds from scratch."""
    global _turbovec_index, _turbovec_dim, _turbovec_count
    if _turbovec_index is not None or not os.path.exists(_turbovec_path):
        return
    try:
        from turbovec import IdMapIndex  # type: ignore

        idx = IdMapIndex.load(_turbovec_path)
        _turbovec_index = idx
        _turbovec_count = _turbovec_safe_count(idx)
        _turbovec_dim = getattr(idx, "dim", None) or _turbovec_dim
    except Exception:  # noqa: BLE001 — corrupt/stale file or missing dep → stay cold
        _turbovec_index = None


def _turbovec_ensure(dim: int) -> Any:
    """Return the live IdMapIndex, loading from disk or creating empty on first use.
    Raises 503 if turbovec/numpy isn't installed. `dim` (the vector length) is used
    only when creating fresh — a loaded index keeps its own dim, and a mismatched
    add surfaces turbovec's own error as a 500 (the clear+backfill flow avoids it)."""
    global _turbovec_index, _turbovec_dim, _turbovec_bit_width, _turbovec_count
    with _turbovec_lock:
        if _turbovec_index is not None:
            return _turbovec_index
        try:
            from turbovec import IdMapIndex  # type: ignore
            import numpy  # noqa: F401 — verified here so the 503 covers a missing numpy
        except ImportError as exc:
            raise HTTPException(
                status_code=503,
                detail=(
                    "turbovec not installed. pip install -r worker/requirements-ml.txt "
                    "(turbovec + numpy) to use the alternative vector index."
                ),
            ) from exc
        bw = int(os.environ.get("TURBOVEC_BIT_WIDTH", "4"))
        if bw not in (2, 4):
            bw = 4
        _turbovec_bit_width = bw
        if os.path.exists(_turbovec_path):
            try:
                idx = IdMapIndex.load(_turbovec_path)
                _turbovec_index = idx
                _turbovec_count = _turbovec_safe_count(idx)
                _turbovec_dim = getattr(idx, "dim", None) or dim
                return idx
            except Exception:  # noqa: BLE001 — corrupt/stale file → rebuild below
                _turbovec_index = None
        idx = IdMapIndex(dim=dim, bit_width=bw)
        _turbovec_index = idx
        _turbovec_dim = dim
        _turbovec_count = 0
        return idx


def _turbovec_persist() -> None:
    """Write the index to disk in-place, best-effort — a persist failure must not
    break the in-memory operation that just succeeded."""
    if _turbovec_index is None:
        return
    try:
        os.makedirs(os.path.dirname(os.path.abspath(_turbovec_path)), exist_ok=True)
        _turbovec_index.write(_turbovec_path)  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001 — persist is best-effort
        pass


class VectorAddIn(BaseModel):
    id: int = Field(..., description="memory_points.embedding_id (the memory_vec rowid).")
    vector: list[float] = Field(..., description="Embedding vector.")


class VectorAddBatchIn(BaseModel):
    items: list[VectorAddIn] = Field(default_factory=list)


class VectorSearchIn(BaseModel):
    vector: list[float]
    k: int = Field(default=10, ge=1, le=200)
    filter_ids: list[int] | None = Field(
        default=None, description="Optional allowlist of ids to restrict the search."
    )


@app.get("/vector/status")
def vector_status() -> dict[str, Any]:
    _turbovec_load_if_present()
    state = _turbovec_health()
    return {
        "state": state,
        # The server's CONFIG.turbovecEnabled gates use; the worker just reports
        # what it has. 'enabled' here means "this worker has turbovec available",
        # surfaced alongside the state so the UI can show off/available/ready.
        "enabled": state != "unavailable",
        "dim": _turbovec_dim,
        "bitWidth": _turbovec_bit_width if state == "ready" else None,
        "count": _turbovec_count,
        "message": (
            None
            if state != "unavailable"
            else "turbovec not installed — pip install -r worker/requirements-ml.txt"
        ),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/vector/add")
def vector_add(body: VectorAddIn) -> dict[str, Any]:
    import numpy as np  # type: ignore

    global _turbovec_count, _turbovec_dim
    try:
        idx = _turbovec_ensure(dim=len(body.vector))
        idx.add_with_ids(
            np.asarray(body.vector, dtype=np.float32)[None, :],
            np.asarray([body.id], dtype=np.uint64),
        )
        _turbovec_dim = len(body.vector)
        _turbovec_count += 1
        _turbovec_persist()
        return {"ok": True, "added": 1}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface a clean 500, never crash
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc


@app.post("/vector/add_batch")
def vector_add_batch(body: VectorAddBatchIn) -> dict[str, Any]:
    import numpy as np  # type: ignore

    if not body.items:
        return {"ok": True, "added": 0}
    global _turbovec_count, _turbovec_dim
    try:
        first_dim = len(body.items[0].vector)
        idx = _turbovec_ensure(dim=first_dim)
        mat = np.asarray([item.vector for item in body.items], dtype=np.float32)
        ids = np.asarray([item.id for item in body.items], dtype=np.uint64)
        idx.add_with_ids(mat, ids)
        _turbovec_dim = first_dim
        _turbovec_count += len(body.items)
        _turbovec_persist()
        return {"ok": True, "added": len(body.items)}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc


@app.post("/vector/search")
def vector_search(body: VectorSearchIn) -> dict[str, Any]:
    import numpy as np  # type: ignore

    global _turbovec_dim
    try:
        idx = _turbovec_ensure(dim=len(body.vector))
        query = np.asarray(body.vector, dtype=np.float32)
        allowlist = (
            np.asarray(body.filter_ids, dtype=np.uint64)
            if body.filter_ids is not None
            else None
        )
        scores, ids = idx.search(query, body.k, allowlist=allowlist)
        hits = [
            {"id": int(i), "score": float(s)}
            for i, s in zip(list(ids), list(scores))
            if int(i) >= 0
        ]
        _turbovec_dim = len(body.vector)
        return {"ok": True, "hits": hits}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc


@app.post("/vector/clear")
def vector_clear() -> dict[str, Any]:
    """Drop the in-memory index AND the persisted file (a full reset). The Node
    backfill route calls this before re-adding everything so stale ids can't
    accumulate from deleted memory_points rows (the join would drop them, but the
    slots would leak)."""
    global _turbovec_index, _turbovec_dim, _turbovec_count
    with _turbovec_lock:
        _turbovec_index = None
        _turbovec_dim = None
        _turbovec_count = 0
    try:
        if os.path.exists(_turbovec_path):
            os.remove(_turbovec_path)
    except OSError:
        pass
    return {"ok": True}


if __name__ == "__main__":  # pragma: no cover
    import signal
    import uvicorn

    # Graceful shutdown: uvicorn's default handles SIGTERM/SIGINT well, but we
    # explicitly configure the signal handlers to ensure clean shutdown during
    # test runs (prevents "Assertion failed: UV_HANDLE_CLOSING" errors).
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=8789, lifespan="on")
    )

    def handle_signal(sig: int, frame) -> None:
        print(f"Received signal {sig}, shutting down gracefully...")
        server.should_exit = True

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    server.run()
