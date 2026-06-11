"""The training loop. Runs in a background thread and mutates a shared status
dict in place so the FastAPI /train/status handler can read live progress.

Faithful to the source repo's recipe: AdamW + a cosine LR schedule with linear
warmup, cross-entropy next-token loss, periodic train/val eval, and text
sampling. Tiny CPU-friendly defaults — see train/__init__.py for why.

torch + train.model are imported at module top; this module is ONLY imported
lazily from worker/main.py inside the /train/* handlers, so the bare worker
still boots without ML deps.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import torch

from .model import GPT, GPTConfig
from .tokenizer import CharTokenizer

# Two profiles: tiny CPU-friendly defaults, and a scaled-up config when a CUDA
# device is present (a ~17M-param model trains in minutes on a laptop GPU and
# learns far more of the corpus than the 1M CPU toy). Each knob is
# env-overridable (SCRATCH_*). Honest either way: this learns the corpus's
# texture and voice, not a capable assistant.
DROPOUT = 0.1
LEARNING_RATE = 3e-4
WARMUP_STEPS = 20
EVAL_INTERVAL = 25
EVAL_ITERS = 10
SAMPLE_TOKENS = 240
# Persist the trained model here (relative to the worker's cwd — the repo root
# in dev, so it lands in the gitignored data/ dir next to brain.sqlite).
CKPT_ROOT = os.environ.get("SCRATCH_LLM_OUT", os.path.join("data", "scratchllm"))
CKPT_SAVE_EVERY = 250  # steps between mid-run checkpoint saves


@dataclass(frozen=True)
class TrainProfile:
    steps: int
    batch_size: int
    block_size: int
    n_layer: int
    n_head: int
    n_embd: int


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def profile_for(device: str) -> TrainProfile:
    gpu = device == "cuda"
    return TrainProfile(
        steps=_env_int("SCRATCH_STEPS", 3000 if gpu else 500),
        batch_size=_env_int("SCRATCH_BATCH", 32 if gpu else 16),
        block_size=_env_int("SCRATCH_BLOCK", 256 if gpu else 128),
        n_layer=_env_int("SCRATCH_N_LAYER", 8 if gpu else 4),
        n_head=_env_int("SCRATCH_N_HEAD", 8 if gpu else 4),
        n_embd=_env_int("SCRATCH_N_EMBD", 384 if gpu else 128),
    )


def default_status() -> dict[str, Any]:
    """The trainer's resting state — keys match shared/learning.LlmTrainerStatus."""
    return {
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lr_at(step: int, total: int) -> float:
    """Linear warmup then cosine decay to 10% of the peak LR."""
    if step < WARMUP_STEPS:
        return LEARNING_RATE * (step + 1) / WARMUP_STEPS
    progress = (step - WARMUP_STEPS) / max(1, total - WARMUP_STEPS)
    progress = min(1.0, max(0.0, progress))
    return LEARNING_RATE * (0.1 + 0.9 * 0.5 * (1.0 + math.cos(math.pi * progress)))


def _get_batch(data: torch.Tensor, block_size: int, batch_size: int, device: str) -> tuple[torch.Tensor, torch.Tensor]:
    high = max(1, data.size(0) - block_size - 1)
    ix = torch.randint(0, high, (batch_size,))
    x = torch.stack([data[i : i + block_size] for i in ix])
    y = torch.stack([data[i + 1 : i + 1 + block_size] for i in ix])
    return x.to(device), y.to(device)


@torch.no_grad()
def _estimate_val_loss(
    model: GPT, data: torch.Tensor, block_size: int, batch_size: int, device: str
) -> float:
    model.eval()
    losses = []
    for _ in range(EVAL_ITERS):
        xb, yb = _get_batch(data, block_size, batch_size, device)
        _, loss = model(xb, yb)
        if loss is not None:
            losses.append(loss.item())
    model.train()
    return sum(losses) / len(losses) if losses else float("nan")


def run_training(corpus: str, status: dict[str, Any], steps: int | None = None) -> None:
    """Train a from-scratch GPT on `corpus`, updating `status` in place.

    Never raises — any failure is recorded as state="error" so the background
    thread dies quietly and the status reflects it.
    """
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        prof = profile_for(device)
        total_steps = steps if steps and steps > 0 else prof.steps

        tokenizer = CharTokenizer(corpus)
        ids = torch.tensor(tokenizer.encode(corpus), dtype=torch.long)
        if ids.numel() < 32:
            status.update(
                state="error",
                message=f"corpus too small after tokenizing ({ids.numel()} tokens)",
                corpusChars=len(corpus),
                updatedAt=_now(),
            )
            return

        # Block size can't exceed the data; keep some room for the +1 target.
        block_size = min(prof.block_size, max(8, ids.numel() // 4))
        n_train = max(1, int(ids.numel() * 0.9))
        train_data = ids[:n_train]
        val_data = ids[n_train:] if ids.numel() - n_train > block_size + 1 else train_data

        cfg = GPTConfig(
            vocab_size=tokenizer.vocab_size,
            block_size=block_size,
            n_layer=prof.n_layer,
            n_head=prof.n_head,
            n_embd=prof.n_embd,
            dropout=DROPOUT,
        )
        model = GPT(cfg).to(device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=0.01)

        status.update(
            state="running",
            step=0,
            totalSteps=total_steps,
            vocabSize=tokenizer.vocab_size,
            params=model.num_params(),
            corpusChars=len(corpus),
            device=device,
            message=f"training on {device}",
            updatedAt=_now(),
        )

        model.train()
        for step in range(total_steps):
            lr = _lr_at(step, total_steps)
            for group in optimizer.param_groups:
                group["lr"] = lr

            xb, yb = _get_batch(train_data, block_size, prof.batch_size, device)
            _, loss = model(xb, yb)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            if step % EVAL_INTERVAL == 0 or step == total_steps - 1:
                val_loss = _estimate_val_loss(model, val_data, block_size, prof.batch_size, device)
                sample = _sample(model, tokenizer, device, block_size)
                status.update(
                    step=step + 1,
                    loss=round(loss.item(), 4),
                    valLoss=round(val_loss, 4),
                    sample=sample,
                    updatedAt=_now(),
                )
            else:
                status.update(step=step + 1, loss=round(loss.item(), 4), updatedAt=_now())

            # Mid-run persistence: a crash/restart keeps the latest model.
            if (step + 1) % CKPT_SAVE_EVERY == 0:
                ckpt = _save_checkpoint(model, tokenizer, cfg)
                status.update(checkpointPath=ckpt, updatedAt=_now())

        final_sample = _sample(model, tokenizer, device, block_size)
        ckpt = _save_checkpoint(model, tokenizer, cfg)
        status.update(
            state="done",
            sample=final_sample,
            checkpointPath=ckpt,
            message=f"training complete — model saved to {ckpt}",
            updatedAt=_now(),
        )
    except Exception as exc:  # noqa: BLE001 — background thread, must not propagate
        status.update(state="error", message=f"{type(exc).__name__}: {exc}", updatedAt=_now())


def _sample(model: GPT, tokenizer: CharTokenizer, device: str, block_size: int) -> str:
    # Seed with a newline if the corpus has one, else token 0.
    seed_id = tokenizer.stoi.get("\n", 0)
    idx = torch.tensor([[seed_id]], dtype=torch.long, device=device)
    out = model.generate(idx, max_new_tokens=SAMPLE_TOKENS, temperature=0.8, top_k=40)
    text = tokenizer.decode(out[0].tolist()).strip()
    return text[:300]


# ---------------------------------------------------------------------------
# Checkpoint persistence + on-demand generation.
#
# The trained model used to be discarded when the training thread ended — only
# a text sample survived. Now the model + arch config + char vocab are saved to
# CKPT_ROOT so /train/generate can speak with the brain's own model any time,
# including after a worker restart.
# ---------------------------------------------------------------------------

_CKPT_FILE = "model.pt"
_VOCAB_FILE = "vocab.json"


def _save_checkpoint(model: GPT, tokenizer: CharTokenizer, cfg: GPTConfig) -> str:
    os.makedirs(CKPT_ROOT, exist_ok=True)
    ckpt_path = os.path.abspath(os.path.join(CKPT_ROOT, _CKPT_FILE))
    vocab_path = os.path.abspath(os.path.join(CKPT_ROOT, _VOCAB_FILE))
    # Atomic-ish: write to a tmp file then replace, so a crash mid-save never
    # leaves a truncated checkpoint that generate() would choke on.
    tmp = ckpt_path + ".tmp"
    # Float tensors are stored fp16, halving the checkpoint on disk.
    # load_state_dict copies them back into the model's fp32 params, so
    # generation math is unchanged (the cast loses < 0.1% of weight precision,
    # imperceptible at this scale).
    torch.save(
        {
            "state_dict": {
                k: (v.cpu().half() if v.is_floating_point() else v.cpu())
                for k, v in model.state_dict().items()
            },
            "config": {
                "vocab_size": cfg.vocab_size,
                "block_size": cfg.block_size,
                "n_layer": cfg.n_layer,
                "n_head": cfg.n_head,
                "n_embd": cfg.n_embd,
                "dropout": cfg.dropout,
            },
        },
        tmp,
    )
    os.replace(tmp, ckpt_path)
    # itos in index order — CharTokenizer("".join(chars)) reproduces the exact
    # mapping because the saved chars are already the sorted unique set.
    chars = [model_char for _, model_char in sorted(tokenizer.itos.items())]
    tmp_v = vocab_path + ".tmp"
    with open(tmp_v, "w", encoding="utf-8") as f:
        json.dump({"chars": chars}, f, ensure_ascii=False)
    os.replace(tmp_v, vocab_path)
    return ckpt_path


def checkpoint_path() -> str | None:
    """Absolute path of the persisted model, or None if never trained."""
    p = os.path.abspath(os.path.join(CKPT_ROOT, _CKPT_FILE))
    v = os.path.abspath(os.path.join(CKPT_ROOT, _VOCAB_FILE))
    return p if os.path.exists(p) and os.path.exists(v) else None


# Generation cache: (mtime, model, tokenizer). Reloaded when the checkpoint
# changes on disk (a fresh training run replaced it). Generation runs on CPU
# deliberately — a <20M-param model is fast there and this never contends with
# an in-flight training run for VRAM.
_gen_lock = threading.Lock()
_gen_cache: tuple[float, GPT, CharTokenizer] | None = None


def _load_for_generation() -> tuple[GPT, CharTokenizer]:
    global _gen_cache
    path = checkpoint_path()
    if path is None:
        raise FileNotFoundError("no trained model yet — train first (POST /train/start)")
    mtime = os.path.getmtime(path)
    with _gen_lock:
        if _gen_cache is not None and _gen_cache[0] == mtime:
            return _gen_cache[1], _gen_cache[2]
        raw = torch.load(path, map_location="cpu")
        cfg = GPTConfig(**raw["config"])
        model = GPT(cfg)
        model.load_state_dict(raw["state_dict"])
        model.eval()
        with open(os.path.join(CKPT_ROOT, _VOCAB_FILE), "r", encoding="utf-8") as f:
            chars = json.load(f)["chars"]
        tokenizer = CharTokenizer("".join(chars))
        _gen_cache = (mtime, model, tokenizer)
        return model, tokenizer


def generate_text(
    prompt: str = "",
    max_new_tokens: int = 200,
    temperature: float = 0.8,
) -> dict[str, Any]:
    """Sample from the persisted brain-LLM. Raises FileNotFoundError when no
    checkpoint exists — the caller maps that to a clean HTTP 404."""
    started = time.time()
    model, tokenizer = _load_for_generation()
    seed = tokenizer.encode(prompt) if prompt else []
    if not seed:
        seed = [tokenizer.stoi.get("\n", 0)]
    idx = torch.tensor([seed[-model.cfg.block_size :]], dtype=torch.long)
    out = model.generate(idx, max_new_tokens=max_new_tokens, temperature=temperature, top_k=40)
    text = tokenizer.decode(out[0].tolist()[len(seed[-model.cfg.block_size :]) :])
    return {
        "text": text,
        "latencyMs": round((time.time() - started) * 1000),
        "params": model.num_params(),
        "device": "cpu",
    }
