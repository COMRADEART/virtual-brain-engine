"""AirLLM high-parameter inference engine.

AirLLM (github.com/lyogavin/airllm) runs LARGE models (7B…70B, even 405B) on a
small GPU by loading the transformer ONE LAYER AT A TIME: each layer's weights
are streamed onto the GPU, the forward runs, then the layer is offloaded. The
resident VRAM footprint is ~one layer, so a 6GB card can run a model far larger
than it could ever hold at once. The trade-off is SPEED — layer-by-layer
inference is slow (seconds-to-minutes per generation), so this is for occasional
high-quality generation / distillation, NOT the hot path.

INFERENCE ONLY — airllm has no training. The brain uses it two ways:
  1. /airllm/generate — query a high-parameter model directly (a bigger brain on
     the small GPU).
  2. As a DISTILLATION TEACHER for the mango LoRA trainer (finetune/trainer.py +
     airllm_engine/distill.py): the big model authors clean instructional
     answers from the memory corpus, and the small mango student trains on them.

Everything is lazy: airllm/torch are imported only inside load_model()/generate(),
so the bare worker still boots without ML deps (status -> 'unavailable'). The
module top level imports stdlib ONLY, so `from airllm_engine.engine import …` is
always safe — main.py relies on that for the /healthz probe.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

# A mid-size instruct model is the honest default: large enough to teach a 0.5B
# student something it doesn't already know, small enough that layer-by-layer
# inference on a 6GB GPU is merely slow rather than impractical. Override with
# AIRLLM_TEACHER_MODEL (e.g. Qwen/Qwen2.5-14B-Instruct, even a 70B).
_DEFAULT_MODEL = os.environ.get("AIRLLM_TEACHER_MODEL", "Qwen/Qwen2.5-7B-Instruct")
_DEFAULT_COMPRESSION = os.environ.get("AIRLLM_COMPRESSION", "4bit")
_MAX_NEW_TOKENS_CAP = 2048
_INPUT_MAX_LEN = 1024

_lock = threading.Lock()

# Live status, surfaced at /airllm/status. Keys mirror shared/learning.AirllmStatus.
STATUS: dict[str, Any] = {
    "state": "idle",  # idle | loading | ready | generating | error | unavailable
    "model": None,
    "compression": None,
    "device": None,
    "message": None,
    "updatedAt": None,
}

_model: Any | None = None
_model_id: str | None = None


class AirllmUnavailable(ImportError):
    """airllm / torch not installed — distinct from a model-load/runtime error."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_compression(value: str | None) -> str | None:
    """'4bit'/'8bit' (with aliases) -> canonical; everything else -> None (off).

    Pure — exercised in isolation by the worker tests; mirrors the canonical set
    airllm's bitsandbytes path accepts.
    """
    v = (value or "").strip().lower()
    if v in ("4bit", "4-bit", "int4"):
        return "4bit"
    if v in ("8bit", "8-bit", "int8"):
        return "8bit"
    return None  # "off"/"none"/"" / unknown -> no compression


def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001 — torch missing or broken -> treat as CPU
        return False


def status_snapshot() -> dict[str, Any]:
    return dict(STATUS)


def load_model(model_id: str | None = None, compression: str | None = None) -> Any:
    """Lazy-load an airllm model (singleton). Reloads only when the id changes.

    Raises AirllmUnavailable when airllm/torch aren't installed; any other
    failure propagates as-is (the caller maps it to a 500 + STATUS=error).
    """
    global _model, _model_id
    target = (model_id or _DEFAULT_MODEL).strip()
    comp = normalize_compression(compression if compression is not None else _DEFAULT_COMPRESSION)
    with _lock:
        if _model is not None and _model_id == target:
            return _model
        try:
            import torch  # noqa: F401 — presence check; used downstream
            from airllm import AutoModel
        except ImportError as exc:
            STATUS.update(
                state="unavailable",
                message=f"airllm not installed: {exc}",
                updatedAt=_now(),
            )
            raise AirllmUnavailable(str(exc)) from exc

        device = "cuda" if _cuda_available() else "cpu"
        STATUS.update(
            state="loading",
            model=target,
            compression=comp,
            device=device,
            message=(
                f"loading {target} via airllm (layer-by-layer"
                f"{', ' + comp if comp else ''}) on {device}…"
            ),
            updatedAt=_now(),
        )
        kwargs: dict[str, Any] = {}
        if comp:
            kwargs["compression"] = comp
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        if token:
            kwargs["hf_token"] = token
        try:
            _model = AutoModel.from_pretrained(target, **kwargs)
        except Exception as exc:  # noqa: BLE001 — surface in STATUS, then re-raise
            STATUS.update(state="error", message=f"load failed: {exc}", updatedAt=_now())
            raise
        _model_id = target
        STATUS.update(state="ready", message=f"{target} ready", updatedAt=_now())
        return _model


def free_model() -> None:
    """Drop the resident model + free GPU memory. The distillation pre-pass calls
    this to release the big teacher BEFORE the small student model loads, so the
    two never contend for the 6GB GPU at once."""
    global _model, _model_id
    with _lock:
        _model = None
        _model_id = None
        STATUS.update(state="idle", message="teacher unloaded", updatedAt=_now())
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 — best-effort cleanup
        pass


def generate(
    prompt: str,
    max_new_tokens: int = 256,
    model_id: str | None = None,
    compression: str | None = None,
) -> dict[str, Any]:
    """Generate from the high-parameter model. Returns {text, model, device,
    latencyMs}. Raises AirllmUnavailable when deps are missing."""
    model = load_model(model_id, compression)
    import torch

    max_new = max(1, min(int(max_new_tokens), _MAX_NEW_TOKENS_CAP))
    # Instruct models: frame the prompt with the model's own chat template when
    # one is present (Qwen ships one). Falls back to the raw prompt otherwise.
    text = prompt
    try:
        tmpl = getattr(model.tokenizer, "chat_template", None)
        if tmpl and hasattr(model.tokenizer, "apply_chat_template"):
            text = model.tokenizer.apply_chat_template(
                [{"role": "user", "content": prompt}],
                tokenize=False,
                add_generation_prompt=True,
            )
    except Exception:  # noqa: BLE001 — template optional; raw prompt is fine
        text = prompt

    enc = model.tokenizer(
        text,
        return_tensors="pt",
        return_attention_mask=False,
        padding=False,
    )
    input_ids = enc["input_ids"]
    # Detect + report truncation rather than silently dropping the tail: a prompt
    # over the token cap is clipped to the head (the instruction), and the caller
    # is told via `truncated`/`inputTokens` so it can surface that the input
    # didn't fully fit.
    full_len = int(input_ids.shape[-1])
    truncated = full_len > _INPUT_MAX_LEN
    if truncated:
        input_ids = input_ids[:, :_INPUT_MAX_LEN]
    if _cuda_available():
        input_ids = input_ids.cuda()

    STATUS.update(state="generating", updatedAt=_now())
    started = time.perf_counter()
    try:
        with torch.no_grad():
            out = model.generate(
                input_ids,
                max_new_tokens=max_new,
                use_cache=True,
                return_dict_in_generate=True,
            )
    except Exception as exc:  # noqa: BLE001 — record + re-raise for a 500
        STATUS.update(state="error", message=f"generate failed: {exc}", updatedAt=_now())
        raise
    seq = out.sequences[0]
    # Decode only the NEW tokens — strip the prompt prefix so we return the
    # answer, not the echoed prompt. Always slice from prompt_len: when the model
    # emits nothing new this yields an EMPTY string (never the echoed prompt).
    prompt_len = int(input_ids.shape[-1])
    gen_ids = seq[prompt_len:]
    decoded = model.tokenizer.decode(gen_ids, skip_special_tokens=True).strip()
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    STATUS.update(state="ready", updatedAt=_now())
    return {
        "text": decoded,
        "model": _model_id,
        "device": STATUS["device"],
        "latencyMs": elapsed_ms,
        "truncated": truncated,
        "inputTokens": full_len,
    }
