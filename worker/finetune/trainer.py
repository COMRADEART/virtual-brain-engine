"""LoRA continued-pretraining loop for the brain's own model.

Runs in a background thread and mutates a shared status dict in place so the
FastAPI /ownmodel/status handler can read live progress — same pattern as
train/trainer.py.

Pipeline: load base (Qwen2.5-0.5B by default) → tokenize the corpus into
causal-LM blocks → wrap with a LoRA adapter (attention + MLP projections) →
AdamW + cosine LR over the LoRA params only → merge the adapter back into the
base → save a self-contained HF model dir the Node side hands to `ollama create`.

torch + transformers + peft are imported at module top; this module is ONLY
imported lazily from worker/main.py inside the /ownmodel/* handlers, so the bare
worker still boots without ML deps.
"""
from __future__ import annotations

import math
import os
import time
from datetime import datetime, timezone
from typing import Any

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

# Small, laptop-GPU-friendly defaults. A 0.5B base in fp16 (~1GB) + a LoRA
# adapter trains in minutes on a 6GB card; the corpus is personal-sized.
#
# The INSTRUCT variant is the default base (was the raw 0.5B): a CPT-adapted
# BASE model can't follow instructions, end its turns, or emit tool calls — the
# instruct model already does all three, and the low-rank LoRA pass layers the
# brain's voice on top without erasing that. Same size, same speed.
DEFAULT_BASE_MODEL = os.environ.get("OWN_MODEL_BASE", "Qwen/Qwen2.5-0.5B-Instruct")
DEFAULT_STEPS = 300
MICRO_BATCH = 2
GRAD_ACCUM = 8
BLOCK_SIZE = 256
# Gentle by default. 2e-4 × 250 steps (the original CPT recipe) measurably
# OVERWRITES a 0.5B instruct base's behavior — the merged model stopped
# following instructions or ending turns and regurgitated corpus chunks to the
# token cap (verified directly on the merged HF model, not an Ollama artifact).
# Behavior preservation comes first; the corpus voice is layered lightly.
def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

LEARNING_RATE = _env_float("OWN_MODEL_LR", 5e-5)
WARMUP_STEPS = 15
LORA_R = 16
LORA_ALPHA = 32
LORA_DROPOUT = 0.05
EVAL_INTERVAL = 25
# Where the merged model is written. The Node side reads this path back from the
# status and points `ollama create` at it. Lives under the repo's gitignored
# data/ dir by default.
OUTPUT_ROOT = os.environ.get("OWN_MODEL_OUT", os.path.join("data", "ownmodel"))
MODEL_NAME = os.environ.get("OWN_MODEL_NAME", "mango")

# LoRA targets for Llama/Qwen-family decoder blocks. If a base uses different
# module names, peft raises and we surface it as state="error" rather than
# guessing.
_LORA_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def default_status() -> dict[str, Any]:
    """The own-model trainer's resting state — keys match shared/learning.OwnModelStatus."""
    return {
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lr_at(step: int, total: int) -> float:
    """Linear warmup then cosine decay to 10% of the peak LR."""
    if step < WARMUP_STEPS:
        return LEARNING_RATE * (step + 1) / WARMUP_STEPS
    progress = (step - WARMUP_STEPS) / max(1, total - WARMUP_STEPS)
    progress = min(1.0, max(0.0, progress))
    return LEARNING_RATE * (0.1 + 0.9 * 0.5 * (1.0 + math.cos(math.pi * progress)))


def _get_batch(ids: torch.Tensor, block_size: int, batch_size: int, device: str) -> torch.Tensor:
    high = max(1, ids.size(0) - block_size - 1)
    ix = torch.randint(0, high, (batch_size,))
    x = torch.stack([ids[i : i + block_size] for i in ix])
    return x.to(device)


def run_finetune(
    corpus: str,
    status: dict[str, Any],
    steps: int | None = None,
    base_model: str | None = None,
) -> None:
    """LoRA-continued-pretrain `base_model` on `corpus`, updating `status` in place.

    Never raises — any failure is recorded as state="error" so the background
    thread dies quietly and the status reflects it.
    """
    try:
        total_steps = steps if steps and steps > 0 else DEFAULT_STEPS
        base = base_model or DEFAULT_BASE_MODEL
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32

        status.update(
            state="running",
            step=0,
            totalSteps=total_steps,
            baseModel=base,
            corpusChars=len(corpus),
            device=device,
            message=f"loading base model {base} on {device}…",
            updatedAt=_now(),
        )

        tokenizer = AutoTokenizer.from_pretrained(base)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        # CHAT-FORMATTED packing, not a raw text stream. Two failed recipes
        # taught us this (both measured: done_reason=length at the client cap on
        # a one-sentence question): (1) one continuous stream teaches an
        # instruct base that text never ends; (2) plain EOS-separated documents
        # still teach "after <eos> comes more text". Wrapping every document as
        # a user→assistant exchange via the model's own chat template makes the
        # LoRA pass PRACTICE the assistant structure — answer in the corpus's
        # voice, then end the turn — instead of eroding it.
        docs: list[str] = []
        buf = ""
        for para in corpus.split("\n\n"):
            if not para.strip():
                continue
            buf = f"{buf}\n\n{para}" if buf else para
            if len(buf) >= 1000:
                docs.append(buf)
                buf = ""
        if buf:
            docs.append(buf)
        prompts = [
            "Tell me about this.",
            "What do you know about this topic?",
            "Share what you remember.",
            "Explain this from your memory.",
        ]
        # apply_chat_template's tokenize= return type varies across transformers
        # major versions (5.x hands back a string) — format to text, tokenize
        # explicitly. add_special_tokens=False: the template already carries the
        # im_start/im_end specials.
        episode_texts = [
            tokenizer.apply_chat_template(
                [
                    {"role": "user", "content": prompts[i % len(prompts)]},
                    {"role": "assistant", "content": doc},
                ],
                tokenize=False,
                add_generation_prompt=False,
            )
            for i, doc in enumerate(docs)
        ]
        pieces: list[int] = []
        for episode in tokenizer(episode_texts, add_special_tokens=False).input_ids:
            pieces.extend(episode)
        ids = torch.tensor(pieces, dtype=torch.long)
        # Need at least a couple of blocks to form batches + a val signal.
        block_size = min(BLOCK_SIZE, max(16, ids.numel() // 4))
        if ids.numel() < block_size * 2:
            status.update(
                state="error",
                message=f"corpus too small after tokenizing ({ids.numel()} tokens)",
                updatedAt=_now(),
            )
            return

        # transformers 5.x renamed `torch_dtype` -> `dtype`; 4.x only knows the
        # old name. Try the new keyword first, fall back so both versions work.
        try:
            model = AutoModelForCausalLM.from_pretrained(base, dtype=dtype)
        except TypeError:
            model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=dtype)
        # Gradient checkpointing keeps the 0.5B activations inside 6GB; LoRA needs
        # input grads enabled when the base is frozen + checkpointed.
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
        model.config.use_cache = False

        lora = LoraConfig(
            r=LORA_R,
            lora_alpha=LORA_ALPHA,
            lora_dropout=LORA_DROPOUT,
            target_modules=_LORA_TARGETS,
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, lora)
        model.to(device)
        model.train()

        trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        optimizer = torch.optim.AdamW(
            (p for p in model.parameters() if p.requires_grad),
            lr=LEARNING_RATE,
            weight_decay=0.0,
        )

        status.update(
            trainableParams=trainable,
            message=f"training on {device} ({trainable:,} trainable LoRA params)",
            updatedAt=_now(),
        )

        optimizer.zero_grad(set_to_none=True)
        for step in range(total_steps):
            lr = _lr_at(step, total_steps)
            for group in optimizer.param_groups:
                group["lr"] = lr

            # Gradient accumulation: GRAD_ACCUM micro-batches per optimizer step.
            accum_loss = 0.0
            for _ in range(GRAD_ACCUM):
                xb = _get_batch(ids, block_size, MICRO_BATCH, device)
                out = model(input_ids=xb, labels=xb)
                loss = out.loss / GRAD_ACCUM
                loss.backward()
                accum_loss += float(loss.item())
            torch.nn.utils.clip_grad_norm_(
                (p for p in model.parameters() if p.requires_grad), 1.0
            )
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)

            status.update(step=step + 1, loss=round(accum_loss, 4), updatedAt=_now())

        # --- Merge the adapter back into the base + save a standalone HF dir ---
        status.update(state="merging", message="merging LoRA adapter into base…", updatedAt=_now())
        model.config.use_cache = True
        merged = model.merge_and_unload()
        out_dir = os.path.abspath(os.path.join(OUTPUT_ROOT, MODEL_NAME))
        os.makedirs(out_dir, exist_ok=True)
        # Save in fp16 to keep the on-disk model small and Ollama-import-friendly.
        merged.half().save_pretrained(out_dir, safe_serialization=True)
        tokenizer.save_pretrained(out_dir)

        # Export a GGUF for Ollama. `ollama create FROM <safetensors-dir>`
        # mis-imports transformers-5.x output (decodes to a single repeated
        # token), so we hand Ollama a ready GGUF instead. Failure-isolated: if
        # the export fails we still report the trained HF model as done (the
        # Node side can fall back to the dir or the user can convert manually).
        gguf_path: str | None = None
        try:
            status.update(message="exporting GGUF for Ollama…", updatedAt=_now())
            from .gguf_export import export_gguf

            gguf_path = export_gguf(out_dir, os.path.join(out_dir, "model.gguf"))
        except Exception as gex:  # noqa: BLE001 — GGUF export is best-effort
            status.update(message=f"GGUF export failed ({type(gex).__name__}: {gex})", updatedAt=_now())

        status.update(
            state="done",
            outputDir=out_dir,
            ggufPath=gguf_path,
            modelName=MODEL_NAME,
            message=(
                f"training complete — GGUF at {gguf_path}"
                if gguf_path
                else f"training complete — merged model at {out_dir} (GGUF export failed; see prior message)"
            ),
            updatedAt=_now(),
        )
    except Exception as exc:  # noqa: BLE001 — background thread, must not propagate
        status.update(state="error", message=f"{type(exc).__name__}: {exc}", updatedAt=_now())
