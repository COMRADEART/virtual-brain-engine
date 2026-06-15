"""Knowledge distillation: a high-parameter airllm TEACHER authors clean
instructional answers from the brain's memory corpus, which the small mango LoRA
student then trains on.

This is how an INFERENCE-ONLY big model "improves the training" of mango: the
student doesn't learn the raw corpus chunks (terse, fragmentary), it learns the
teacher's distilled explanations of them. Classic teacher→student distillation,
adapted to a personal corpus.

Bounded + failure-isolated by construction:
  - capped at `max_docs` notes (layer-by-layer teacher inference is slow, so a
    whole corpus would take hours — we distill the first N and train on those),
  - each note distilled independently (a teacher failure on one note skips THAT
    note, never the run),
  - too-short / empty teacher answers are dropped rather than poisoning the set.

`split_docs` mirrors finetune/trainer.py's packing so the distilled and raw
training paths chunk the corpus identically.
"""
from __future__ import annotations

import os
from typing import Any, Callable

_MAX_DISTILL_DOCS = max(1, int(os.environ.get("AIRLLM_MAX_DISTILL_DOCS", "40") or "40"))
_TEACHER_MAX_NEW_TOKENS = max(32, int(os.environ.get("AIRLLM_DISTILL_MAX_TOKENS", "320") or "320"))
_MIN_ANSWER_CHARS = 40

# The student is prompted with the SAME instructions finetune/trainer.py uses for
# the raw path, so a model trained on distilled episodes and one trained on raw
# episodes see the same question distribution — only the ANSWER quality differs.
STUDENT_INSTRUCTIONS = [
    "Tell me about this.",
    "What do you know about this topic?",
    "Share what you remember.",
    "Explain this from your memory.",
]


def split_docs(corpus: str, target_chars: int = 1000) -> list[str]:
    """Pack the corpus into ~target_chars docs on paragraph boundaries."""
    docs: list[str] = []
    buf = ""
    for para in corpus.split("\n\n"):
        if not para.strip():
            continue
        buf = f"{buf}\n\n{para}" if buf else para
        if len(buf) >= target_chars:
            docs.append(buf)
            buf = ""
    if buf:
        docs.append(buf)
    return docs


def teacher_prompt(doc: str) -> str:
    """The instruction handed to the big teacher for one note. Pure — covered by
    the worker tests."""
    return (
        "You are teaching a smaller model. Read the note below and write a clear, "
        "self-contained explanation of the key facts it contains, in plain English. "
        "Be accurate and concise. Do not mention that you were given a note.\n\n"
        f"NOTE:\n{doc.strip()}\n\nEXPLANATION:"
    )


def build_distilled_episodes(
    corpus: str,
    generate_fn: Callable[..., dict[str, Any]],
    max_docs: int | None = None,
    status: dict[str, Any] | None = None,
    now_fn: Callable[[], str] | None = None,
) -> list[tuple[str, str]]:
    """Return (student_instruction, teacher_answer) episode pairs.

    `generate_fn(prompt=…, max_new_tokens=…) -> {"text": str}` is the teacher
    (injected, so this is testable without airllm). Per-note failure-isolated.
    """
    docs = split_docs(corpus)
    cap = max_docs if (max_docs and max_docs > 0) else _MAX_DISTILL_DOCS
    selected = docs[:cap]
    episodes: list[tuple[str, str]] = []
    skipped_short = 0
    for i, doc in enumerate(selected):
        try:
            result = generate_fn(prompt=teacher_prompt(doc), max_new_tokens=_TEACHER_MAX_NEW_TOKENS)
            answer = (result.get("text") or "").strip()
        except Exception:  # noqa: BLE001 — one bad note must not kill the pass
            answer = ""
        if len(answer) < _MIN_ANSWER_CHARS:
            skipped_short += 1
            continue
        episodes.append((STUDENT_INSTRUCTIONS[i % len(STUDENT_INSTRUCTIONS)], answer))
        if status is not None:
            status.update(
                message=f"distilling with teacher… {len(episodes)}/{len(selected)} notes",
                updatedAt=(now_fn() if now_fn else status.get("updatedAt")),
            )
    # Surface short/empty-answer skips rather than silently returning a thin list —
    # a teacher that keeps producing sub-minimal answers reads as "0/N notes",
    # which looks like nothing worked instead of "answers were too short".
    if status is not None and skipped_short:
        status.update(
            message=(
                f"distilled {len(episodes)}/{len(selected)} notes "
                f"({skipped_short} skipped — teacher answer too short)"
            ),
            updatedAt=(now_fn() if now_fn else status.get("updatedAt")),
        )
    return episodes
