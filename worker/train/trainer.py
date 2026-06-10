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

import math
import time
from datetime import datetime, timezone
from typing import Any

import torch

from .model import GPT, GPTConfig
from .tokenizer import CharTokenizer

# Tiny, CPU-friendly defaults. Honest: this learns the corpus's texture, not a
# capable assistant.
DEFAULT_STEPS = 500
BATCH_SIZE = 16
BLOCK_SIZE = 128
N_LAYER = 4
N_HEAD = 4
N_EMBD = 128
DROPOUT = 0.1
LEARNING_RATE = 3e-4
WARMUP_STEPS = 20
EVAL_INTERVAL = 25
EVAL_ITERS = 10
SAMPLE_TOKENS = 240


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
def _estimate_val_loss(model: GPT, data: torch.Tensor, block_size: int, device: str) -> float:
    model.eval()
    losses = []
    for _ in range(EVAL_ITERS):
        xb, yb = _get_batch(data, block_size, BATCH_SIZE, device)
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
        total_steps = steps if steps and steps > 0 else DEFAULT_STEPS
        device = "cuda" if torch.cuda.is_available() else "cpu"

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
        block_size = min(BLOCK_SIZE, max(8, ids.numel() // 4))
        n_train = max(1, int(ids.numel() * 0.9))
        train_data = ids[:n_train]
        val_data = ids[n_train:] if ids.numel() - n_train > block_size + 1 else train_data

        cfg = GPTConfig(
            vocab_size=tokenizer.vocab_size,
            block_size=block_size,
            n_layer=N_LAYER,
            n_head=N_HEAD,
            n_embd=N_EMBD,
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
            message=f"training on {device}",
            updatedAt=_now(),
        )

        model.train()
        for step in range(total_steps):
            lr = _lr_at(step, total_steps)
            for group in optimizer.param_groups:
                group["lr"] = lr

            xb, yb = _get_batch(train_data, block_size, BATCH_SIZE, device)
            _, loss = model(xb, yb)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            if step % EVAL_INTERVAL == 0 or step == total_steps - 1:
                val_loss = _estimate_val_loss(model, val_data, block_size, device)
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

        final_sample = _sample(model, tokenizer, device, block_size)
        status.update(
            state="done",
            sample=final_sample,
            message="training complete",
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
